package api_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/danielgtaylor/huma/v2/adapters/humago"

	"github.com/aquitano/aqt/apps/bank/internal/attic/ai"
	"github.com/aquitano/aqt/apps/bank/internal/attic/api"
	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
)

// served is the catalogue's API over a test database, with a client that
// writes and one that only reads.
func served(t *testing.T) (dsn string, write, read *client.Client) {
	t.Helper()
	st, dsn := storetest.NewCatalogue(t)
	storetest.Exec(t, dsn, `
  insert into volumes(id,label,fs_type,serial,stable_ids) values ('`+volume+`','Archive','TEST','1',true);
  insert into scans(id,volume_id,root,status) overriding system value values (1,'`+volume+`','','complete');
  insert into contents(id,blake3,size_bytes) overriding system value values (1,decode(repeat('ab',32),'hex'),5);
  insert into entries(id,volume_id,parent_id,kind,name,raw_name,path,size_bytes,content_id,hash_state,first_scan,updated_scan) overriding system value values
   (1,'`+volume+`',null,'dir','',''::bytea,'',0,null,'none',1,1),
   (2,'`+volume+`',1,'file','a.png','a.png'::bytea,'/a.png',5,1,'done',1,1),
   (3,'`+volume+`',1,'file','b.png','b.png'::bytea,'/b.png',5,1,'done',1,1)`)
	issued := tokens.Store{Path: filepath.Join(t.TempDir(), "tokens")}
	writeToken, err := issued.New("worker", tokens.Write)
	if err != nil {
		t.Fatal(err)
	}
	readToken, err := issued.New("agent", tokens.Read)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	humaAPI := humago.New(mux, httpapi.Config("test", "", "bank token new <name>"))
	humaAPI.UseMiddleware(httpapi.RequireToken(humaAPI, issued, "bank token new <name>"))
	api.Register(humaAPI, st, nil)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return dsn, client.New(server.URL, writeToken), client.New(server.URL, readToken)
}

var key = ai.Key{Task: ai.Describe, Provider: "test", Model: "one", PromptVersion: "v1"}

func TestReadTokenCannotRecordAMoveOrSaveAnAnalysis(t *testing.T) {
	_, write, read := served(t)
	ctx := t.Context()
	claim, err := client.Call(ctx, write, api.ClaimDiskEnrichment, api.EnrichClaimInput{Body: api.EnrichClaimRequest{ContentID: 1, Key: key}})
	if err != nil || !claim.Claimed {
		t.Fatalf("claim: %+v %v", claim, err)
	}
	for name, call := range map[string]func() error{
		"record a dedupe move": func() error {
			_, err := client.Call(ctx, read, api.RecordDiskDedupeMove, api.DedupeMoveInput{ID: 3,
				Body: api.DedupeMoveRequest{KeptEntryID: 2, MovedTo: `E:\.attic-quarantine\run\b.png`}})
			return err
		},
		"claim enrichment": func() error {
			_, err := client.Call(ctx, read, api.ClaimDiskEnrichment, api.EnrichClaimInput{Body: api.EnrichClaimRequest{ContentID: 1, Key: key}})
			return err
		},
		"save an analysis": func() error {
			_, err := client.Call(ctx, read, api.SaveDiskEnrichment, api.SaveEnrichmentInput{Lease: claim.Lease,
				Body: store.AIOutcome{Result: ai.Result{Text: "a cat"}}})
			return err
		},
	} {
		var failure *client.Error
		if err := call(); !errors.As(err, &failure) || failure.Tag != "Forbidden" {
			t.Errorf("a read token could %s: %v", name, err)
		}
	}
	if _, err := client.Call(ctx, write, api.RecordDiskDedupeMove, api.DedupeMoveInput{ID: 3,
		Body: api.DedupeMoveRequest{KeptEntryID: 2, MovedTo: `E:\.attic-quarantine\run\b.png`}}); err != nil {
		t.Fatalf("a write token could not record the move: %v", err)
	}
}

func TestExpiredEnrichmentClaimIsClaimableAndItsLateResultIsRefused(t *testing.T) {
	dsn, write, _ := served(t)
	ctx := t.Context()
	claim := func() api.EnrichClaim {
		t.Helper()
		c, err := client.Call(ctx, write, api.ClaimDiskEnrichment, api.EnrichClaimInput{Body: api.EnrichClaimRequest{ContentID: 1, Key: key}})
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	first := claim()
	if !first.Claimed || claim().Claimed {
		t.Fatal("a held claim was claimed twice")
	}
	storetest.Exec(t, dsn, `update ai_claims set expires_at = now() - interval '1 second'`)
	second := claim()
	if !second.Claimed || second.Lease == first.Lease {
		t.Fatalf("the expired claim was not claimable again: %+v", second)
	}

	save := func(lease, text string) error {
		_, err := client.Call(ctx, write, api.SaveDiskEnrichment, api.SaveEnrichmentInput{Lease: lease,
			Body: store.AIOutcome{Result: ai.Result{Text: text}}})
		return err
	}
	if err := save(first.Lease, "late"); !errors.Is(err, store.ErrClaimLost) {
		t.Fatalf("the late result was not refused: %v", err)
	}
	if _, err := client.Call(ctx, write, api.RenewDiskEnrichment, api.LeaseInput{Lease: first.Lease}); !errors.Is(err, store.ErrClaimLost) {
		t.Fatalf("the lost lease was renewed: %v", err)
	}
	if err := save(second.Lease, "current"); err != nil {
		t.Fatal(err)
	}
	if n := pgschematest.QueryInt(t, dsn, `select count(*) from ai_results where text = 'current' and status = 'ok'`); n != 1 {
		t.Fatalf("%d current results, want the second worker's only", n)
	}
	if claim().Claimed {
		t.Fatal("finished work was claimed again")
	}
}
