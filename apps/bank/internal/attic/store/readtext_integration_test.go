package store_test

import (
	"bytes"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/attic/storetest"
)

func TestReadTextReturnsOnlyCompleteTextAndPrefersTheDocumentsOwn(t *testing.T) {
	st, dsn := storetest.New(t)
	ctx := t.Context()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	// Content 1 has its own text and an OCR result, 2 only truncated ones,
	// 3 needed OCR and has it.
	if _, err := conn.Exec(ctx, `
  insert into contents(id,blake3,size_bytes) overriding system value values
   (1,decode(repeat('01',32),'hex'),10), (2,decode(repeat('02',32),'hex'),10), (3,decode(repeat('03',32),'hex'),10);
  insert into texts(content_id,status,extractor,text) values
   (1,'ok','pdf','the document text'), (2,'truncated','pdf','the first megabyte'), (3,'needs_ocr','pdf','');
  insert into ai_results(content_id,task,provider,model,prompt_version,status,text) values
   (1,'ocr','local','tesseract','1','ok','the ocr text'),
   (2,'ocr','local','tesseract','1','truncated','the first page'),
   (3,'ocr','local','tesseract','1','ok','the scanned page')`); err != nil {
		t.Fatal(err)
	}
	digest := func(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

	if text, extractor, err := st.ReadText(ctx, digest(1)); err != nil || text != "the document text" || extractor != "pdf" {
		t.Fatalf("text and OCR: %q, %q, %v", text, extractor, err)
	}
	if text, _, err := st.ReadText(ctx, digest(2)); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("truncated text and OCR: %q, %v", text, err)
	}
	if text, extractor, err := st.ReadText(ctx, digest(3)); err != nil || text != "the scanned page" || extractor != "ocr local tesseract" {
		t.Fatalf("OCR only: %q, %q, %v", text, extractor, err)
	}
}
