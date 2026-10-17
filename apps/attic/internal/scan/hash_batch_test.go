package scan

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/config"
	"github.com/aquitano/aqt/apps/attic/internal/store"
	"github.com/aquitano/aqt/apps/attic/internal/storetest"
	"github.com/aquitano/aqt/packages/go/pgschema/pgschematest"
	"lukechampine.com/blake3"
)

func TestHashBatchesKeepDuplicatesAndSizeGuards(t *testing.T) {
	st, dsn := storetest.New(t)
	ctx := context.Background()
	root := t.TempDir()
	for i := range 130 {
		write(t, root, fmt.Sprintf("file-%03d.bin", i), fmt.Sprintf("content-%d", i%5))
	}
	first := scanAt(t, st, root, testVolume, func(o *Options) { o.NoHash = true })
	sc, err := st.StartScan(ctx, first.Volume, "")
	if err != nil {
		t.Fatal(err)
	}
	finished := false
	t.Cleanup(func() {
		if !finished {
			_ = sc.Finish(ctx, "interrupted", nil)
		}
	})
	pending, err := sc.NextPending(ctx, store.Pending{}, 256)
	if err != nil || len(pending) != 130 {
		t.Fatalf("pending: %d files, %v", len(pending), err)
	}
	pgschematest.QueryInt(t, dsn, "update entries set size_bytes=size_bytes+1 where id=$1 returning size_bytes", pending[0].ID)
	for i, p := range pending {
		digest := blake3.Sum256([]byte(fmt.Sprintf("content-%d", i%5)))
		if err := sc.SetContent(ctx, p, digest); err != nil {
			t.Fatal(err)
		}
	}
	finishCtx, cancel := context.WithCancel(ctx)
	cancel()
	finished = true
	if err := sc.Finish(finishCtx, "interrupted", finishCtx.Err()); err != nil {
		t.Fatal(err)
	}
	if sc.Counts.Hashed != 129 || sc.Counts.Duplicates != 125 || sc.Counts.HashedBytes != 129*int64(len("content-0")) {
		t.Fatalf("hash counts: %+v", sc.Counts)
	}
	if n := pgschematest.QueryInt(t, dsn, "select count(*) from entries where hash_state='done'"); n != 129 {
		t.Fatalf("hashed rows: %d", n)
	}
	if n := pgschematest.QueryInt(t, dsn, "select count(*) from contents"); n != 5 {
		t.Fatalf("contents: %d", n)
	}
	if again := scanAt(t, st, root, testVolume); again.Counts.Hashed != 1 || again.Counts.Duplicates != 1 {
		t.Fatalf("resumed counts: %+v", again.Counts)
	}
}

func TestCancelledHashCommitsCompletedWork(t *testing.T) {
	st, dsn := storetest.New(t)
	root := t.TempDir()
	for i := range 130 {
		write(t, root, fmt.Sprintf("file-%03d.bin", i), fmt.Sprintf("content-%d", i%5))
	}
	first := scanAt(t, st, root, testVolume, func(o *Options) { o.NoHash = true })
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	sc, err := st.StartScan(ctx, first.Volume, "")
	if err != nil {
		t.Fatal(err)
	}
	finished := false
	t.Cleanup(func() {
		if !finished {
			_ = sc.Finish(context.Background(), "interrupted", nil)
		}
	})
	r := &run{sc: sc, log: slog.New(slog.DiscardHandler), mountRoot: root,
		rules: config.Default().Rules(first.Volume.ID, first.Volume.Label)}
	r.o.Progress = func(p Progress) {
		r.lastProgress = time.Time{}
		if p.Hashed >= 64 {
			cancel()
		}
	}
	if err := r.hash(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled hash: %v", err)
	}
	finished = true
	if err := sc.Finish(ctx, "interrupted", ctx.Err()); err != nil {
		t.Fatal(err)
	}
	if n := pgschematest.QueryInt(t, dsn, "select count(*) from entries where hash_state='done'"); n != 64 {
		t.Fatalf("completed hashes: %d", n)
	}
	if again := scanAt(t, st, root, testVolume); again.Counts.Hashed != 66 || again.Counts.Duplicates != 66 {
		t.Fatalf("resumed counts: %+v", again.Counts)
	}
}
