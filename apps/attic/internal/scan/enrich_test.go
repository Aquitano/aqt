package scan

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/ai"
	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/enrich"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
)

type visionStub struct {
	key   ai.Key
	read  func(context.Context, string) (ai.Result, error)
	calls int
}

func (p *visionStub) Key() ai.Key          { return p.key }
func (p *visionStub) Extensions() []string { return []string{"png", "pdf"} }
func (p *visionStub) Read(ctx context.Context, path string) (ai.Result, error) {
	p.calls++
	return p.read(ctx, path)
}

func TestEnrichDedupRetriesVersionsAndSearch(t *testing.T) {
	st, dsn := storetest.New(t)
	root := t.TempDir()
	write(t, root, "a.png", "same image")
	write(t, root, "b.png", "same image")
	write(t, root, "c.png", "bad image")
	scanAt(t, st, root, testVolume)
	vols, err := st.KnownVolumes(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.AI.Temp = t.TempDir()
	fail := true
	p := &visionStub{key: ai.Key{Task: ai.Describe, Provider: "test", Model: "one", PromptVersion: "v1"}}
	p.read = func(_ context.Context, path string) (ai.Result, error) {
		if !strings.HasPrefix(path, cfg.AI.Temp+string(filepath.Separator)) {
			t.Errorf("provider got original path %s", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return ai.Result{}, err
		}
		if string(data) == "bad image" && fail {
			return ai.Result{}, errors.New("try again")
		}
		return ai.Result{Text: "yellow submarine", ReportedModel: p.key.Model}, nil
	}
	o := enrich.Options{Config: cfg, Provider: p, Limit: 20, Mounts: map[string]disk.Volume{vols[0].ID: {Fingerprint: testVolume, Root: root}}}
	run := func() enrich.Summary {
		t.Helper()
		s, err := enrich.Run(t.Context(), st, o)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	if s := run(); s.Attempted != 2 || s.Saved != 1 || s.Failed != 1 {
		t.Fatalf("first %+v", s)
	}
	fail = false
	if s := run(); s.Attempted != 1 || s.Saved != 1 {
		t.Fatalf("retry %+v", s)
	}
	if s := run(); s.Attempted != 0 {
		t.Fatalf("reused %+v", s)
	}
	if n := storetest.QueryInt(t, dsn, "select max(attempts) from ai_results"); n != 2 {
		t.Fatalf("attempts %d", n)
	}
	p.key.Model = "two"
	if s := run(); s.Attempted != 2 {
		t.Fatalf("new model %+v", s)
	}
	hits, err := st.SearchAI(t.Context(), store.SearchOptions{Query: "submarine", VolumeID: vols[0].ID, Limit: 20})
	if err != nil || len(hits) != 4 {
		t.Fatalf("hits %+v %v", hits, err)
	}
	for _, h := range hits {
		if len(h.Places) == 0 {
			t.Fatalf("missing copies: %+v", h)
		}
		for _, place := range h.Places {
			if place.Ref != h.Ref {
				t.Fatalf("mixed contents: %+v", h)
			}
		}
		want := 2
		if h.Places[0].Path == "/c.png" {
			want = 1
		}
		if len(h.Places) != want {
			t.Fatalf("copies: %+v", h)
		}
	}
	results, err := st.Analyses(t.Context(), 0, "attic:"+strings.ToUpper(hits[0].Ref))
	if err != nil || len(results) != 2 {
		t.Fatalf("analyses %+v %v", results, err)
	}
	if hits, err := st.SearchAI(t.Context(), store.SearchOptions{Query: "submarine", Under: "/absent", Limit: 20}); err != nil || len(hits) != 0 {
		t.Fatalf("filter %+v %v", hits, err)
	}
	// A forced failure must not destroy the searchable answer it replaces.
	o.Selection.Force = true
	p.read = func(context.Context, string) (ai.Result, error) { return ai.Result{}, errors.New("offline") }
	if s := run(); s.Failed != 2 {
		t.Fatalf("forced %+v", s)
	}
	if n := storetest.QueryInt(t, dsn, "select count(*) from ai_results where status='ok'"); n != 4 {
		t.Fatalf("lost good answers: %d", n)
	}
	// A concurrent request cannot claim work already held by another runner.
	files, err := st.NextAI(t.Context(), store.AISelection{Volumes: []string{vols[0].ID}, Extensions: []string{"png"}, Key: p.key, Force: true}, 0, 1)
	if err != nil || len(files) != 1 {
		t.Fatalf("queue %+v %v", files, err)
	}
	release, err := st.ClaimAI(t.Context(), files[0].ContentID, p.key, true)
	if err != nil || release == nil {
		t.Fatalf("claim %v", err)
	}
	defer release.Close()
	other, err := st.ClaimAI(t.Context(), files[0].ContentID, p.key, true)
	if err != nil || other != nil {
		if other != nil {
			other.Close()
		}
		t.Fatalf("double claim %v", err)
	}
}

func TestEnrichSelectionRulesChangedFilesLimitAndCancel(t *testing.T) {
	st, dsn := storetest.New(t)
	root := t.TempDir()
	write(t, root, "a.png", "first")
	write(t, root, "b.png", "second")
	write(t, root, "c.png", "third")
	scanAt(t, st, root, testVolume)
	vols, err := st.KnownVolumes(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.AI.Temp = t.TempDir()
	cfg.NameOnly = []string{"a.png"}
	p := &visionStub{key: ai.Key{Task: ai.OCR, Provider: "test", Model: "one", PromptVersion: "v1"}, read: func(context.Context, string) (ai.Result, error) { return ai.Result{Text: "invoice"}, nil }}
	o := enrich.Options{Config: cfg, Provider: p, Limit: 1, Mounts: map[string]disk.Volume{vols[0].ID: {Fingerprint: testVolume, Root: root}}}
	write(t, root, "b.png", "changed")
	s, err := enrich.Run(t.Context(), st, o)
	if err != nil || s.Attempted != 1 || s.Skipped != 2 {
		t.Fatalf("rules and changed file: %+v %v", s, err)
	}
	if n := storetest.QueryInt(t, dsn, "select count(*) from ai_results"); n != 1 {
		t.Fatalf("stored %d", n)
	}
	// Explicit refs select only that content; changing the model doesn't broaden it.
	files, err := st.NextAI(t.Context(), store.AISelection{Volumes: []string{vols[0].ID}, Extensions: []string{"png"}, Key: p.key, Force: true}, 0, 3)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		entries []int64
		refs    []string
		want    int
	}{
		{"entry", []int64{files[0].ID}, nil, 1},
		{"ref", nil, []string{files[0].Ref}, 1},
		{"mixed", []int64{files[1].ID}, []string{files[0].Ref}, 2},
	} {
		selection := store.AISelection{Volumes: []string{vols[0].ID}, Extensions: []string{"png"}, Key: p.key, Force: true, Entries: tc.entries, Refs: tc.refs}
		selected, err := st.NextAI(t.Context(), selection, 0, 20)
		if err != nil || len(selected) != tc.want {
			t.Fatalf("%s selection: %+v %v", tc.name, selected, err)
		}
		selectedVolumes, err := st.AIVolumes(t.Context(), selection)
		if err != nil || len(selectedVolumes) != 1 || selectedVolumes[0] != vols[0].ID {
			t.Fatalf("%s volumes: %v %v", tc.name, selectedVolumes, err)
		}
	}
	o.Selection.Refs = []string{"attic:" + strings.ToUpper(files[0].Ref)}
	o.Config.NameOnly = nil
	p.key.Model = "two"
	s, err = enrich.Run(t.Context(), st, o)
	if err != nil || s.Attempted != 1 {
		t.Fatalf("ref selection: %+v %v", s, err)
	}
	// Cancellation must keep the previous commits and leave the next model pending.
	p.key.Model = "three"
	ctx, cancel := context.WithCancel(t.Context())
	p.read = func(context.Context, string) (ai.Result, error) { cancel(); return ai.Result{}, ctx.Err() }
	_, err = enrich.Run(ctx, st, o)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel %v", err)
	}
	if n := storetest.QueryInt(t, dsn, "select count(*) from ai_results"); n != 2 {
		t.Fatalf("cancel changed persisted work: %d", n)
	}
}

func TestEnrichPDFQueueAndFolderSelection(t *testing.T) {
	st, dsn := storetest.New(t)
	root := t.TempDir()
	write(t, root, "docs/scanned.pdf", "%PDF-1.4 scanned fixture")
	write(t, root, "docs/failed.pdf", "%PDF-1.4 broken fixture")
	write(t, root, "other.png", "outside selected folder")
	scanAt(t, st, root, testVolume)
	// Seed the text phase's no-text-layer outcome. Failed PDFs stay outside
	// this queue; actual rasterization is tested in the shared extractor.
	n := storetest.QueryInt(t, dsn, `with changed as (update texts set status='needs_ocr' where content_id=(select content_id from entries where path='/docs/scanned.pdf') returning content_id) select count(*) from changed`)
	if n != 1 {
		t.Fatalf("seeded %d PDF states", n)
	}
	vols, err := st.KnownVolumes(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	files, err := st.NextAI(t.Context(), store.AISelection{Volumes: []string{vols[0].ID}, Under: "/docs", Extensions: []string{"pdf", "png"}, Key: ai.Key{Task: ai.OCR, Provider: "test", Model: "one", PromptVersion: "v1"}}, 0, 20)
	if err != nil || len(files) != 1 || files[0].Path != "/docs/scanned.pdf" {
		t.Fatalf("PDF queue %+v %v", files, err)
	}
}

func TestEnrichNewWorkPrecedesPermanentFailures(t *testing.T) {
	st, _ := storetest.New(t)
	root := t.TempDir()
	write(t, root, "a.png", "poison")
	write(t, root, "b.png", "good")
	scanAt(t, st, root, testVolume)
	vols, err := st.KnownVolumes(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	p := &visionStub{key: ai.Key{Task: ai.Describe, Provider: "test", Model: "one", PromptVersion: "v1"}, read: func(_ context.Context, path string) (ai.Result, error) {
		data, err := os.ReadFile(path)
		if err != nil {
			return ai.Result{}, err
		}
		if string(data) == "poison" {
			return ai.Result{}, errors.New("permanent failure")
		}
		return ai.Result{Text: "submarine"}, nil
	}}
	cfg := config.Default()
	cfg.AI.Temp = t.TempDir()
	o := enrich.Options{Config: cfg, Provider: p, Limit: 1, Mounts: map[string]disk.Volume{vols[0].ID: {Fingerprint: testVolume, Root: root}}}
	first, err := enrich.Run(t.Context(), st, o)
	if err != nil || first.Failed != 1 {
		t.Fatalf("first %+v %v", first, err)
	}
	second, err := enrich.Run(t.Context(), st, o)
	if err != nil || second.Saved != 1 {
		t.Fatalf("second %+v %v", second, err)
	}
	third, err := enrich.Run(t.Context(), st, o)
	if err != nil || third.Failed != 1 {
		t.Fatalf("retry %+v %v", third, err)
	}
}

func TestEnrichUnavailableProviderAndRejectedInput(t *testing.T) {
	for _, mode := range []string{"unavailable", "disconnect", "rejected"} {
		t.Run(mode, func(t *testing.T) {
			unavailable := mode != "rejected"
			st, dsn := storetest.New(t)
			root := t.TempDir()
			data, err := os.ReadFile("../ai/testdata/invoice.png")
			if err != nil {
				t.Fatal(err)
			}
			write(t, root, "c.png", string(data))
			if unavailable {
				write(t, root, "d.png", string(data)+"different content")
			} else {
				write(t, root, "a.png", strings.Repeat("x", 21<<20))
				write(t, root, "a-copy.png", strings.Repeat("x", 21<<20))
				write(t, root, "b.png", "not an image")
			}
			scanAt(t, st, root, testVolume)
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				if mode == "disconnect" {
					w.Header().Set("Content-Length", "1000")
					fmt.Fprint(w, `{"choices":`)
					return
				}
				if unavailable {
					w.WriteHeader(http.StatusNotFound)
					fmt.Fprint(w, `{"error":"model not found"}`)
					return
				}
				fmt.Fprint(w, `{"choices":[{"finish_reason":"stop","message":{"content":"invoice"}}]}`)
			}))
			defer server.Close()
			cfg := config.Default()
			cfg.AI.Temp = t.TempDir()
			cfg.AI.Model = "test"
			cfg.AI.Endpoint = server.URL
			p, err := ai.New(t.Context(), cfg.AI, ai.Describe)
			if err != nil {
				t.Fatal(err)
			}
			vols, err := st.KnownVolumes(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			s, err := enrich.Run(t.Context(), st, enrich.Options{Config: cfg, Provider: p, Limit: 20, Mounts: map[string]disk.Volume{vols[0].ID: {Fingerprint: testVolume, Root: root}}})
			if requests.Load() != 1 || s.Attempted != 1 {
				t.Fatalf("requests=%d summary=%+v err=%v", requests.Load(), s, err)
			}
			rows := storetest.QueryInt(t, dsn, "select count(*) from ai_results")
			if unavailable {
				if !errors.Is(err, ai.ErrUnavailable) || rows != 0 {
					t.Fatalf("outage: %+v %v rows=%d", s, err, rows)
				}
			} else if err != nil || s.Skipped != 2 || s.Saved != 1 || rows != 1 {
				t.Fatalf("inputs: %+v %v rows=%d", s, err, rows)
			}
		})
	}
}
