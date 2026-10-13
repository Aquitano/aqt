package store_test

import (
	"context"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestSearchRetrievalCases(t *testing.T) {
	ctx := context.Background()
	st, dsn := storetest.NewNamed(t)
	corpus := []store.Message{
		{ExternalID: "invoice", Subject: "Hetzner invoice", Body: "Your monthly hosting bill", Sender: "billing@example.com"},
		{ExternalID: "noise", Subject: "Weekend plans", Body: "invoice"},
		{ExternalID: "typo", Subject: "Hetzner invoixe", Body: "Your monthly hosting bill"},
		{ExternalID: "cross-field", Sender: "Alice", Body: "retainer agreement"},
		{ExternalID: "phrase", Body: "We agreed to a quarterly review of the retainer."},
		{ExternalID: "reversed", Body: "review the quarterly retainer"},
		{ExternalID: "attachment", Body: "Please see the document"},
	}
	byID := map[int64]string{}
	for _, m := range corpus {
		id, err := st.InsertMessage(ctx, msg("notes", m.ExternalID, m))
		if err != nil {
			t.Fatal(err)
		}
		byID[id] = m.ExternalID
	}
	storetest.Exec(t, dsn, `update messages set attachment_text='signed orbital contract' where external_id='attachment'`)
	cases := []struct {
		name, query, mode, first string
		count                    int
	}{
		{"exact title ahead of typo and incidental body", "hetzner invoice", "any", "invoice", 3},
		{"all words span sender and body", "Alice retainer", "all", "cross-field", 1},
		{"phrase keeps order and adjacency", "quarterly review", "phrase", "phrase", 1},
		{"fuzzy finds misspelled query", "hetzner invoicce", "all", "invoice", 1},
		{"attachment-only match", "orbital contract", "all", "attachment", 1},
		{"all excludes partial matches", "hetzner invoice", "all", "invoice", 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			results, err := st.Search(ctx, tc.query, store.SearchOpts{Match: tc.mode, Fuzzy: 1, Limit: 20})
			if err != nil {
				t.Fatal(err)
			}
			if len(results) != tc.count {
				t.Fatalf("got %d results, want %d: %+v", len(results), tc.count, results)
			}
			if tc.first != "" && byID[results[0].ID] != tc.first {
				t.Fatalf("top result=%s, want %s", byID[results[0].ID], tc.first)
			}
		})
	}
}
