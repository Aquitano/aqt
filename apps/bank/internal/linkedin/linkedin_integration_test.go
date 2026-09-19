package linkedin

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
)

func TestReimportRepairsTitleKeyedConversation(t *testing.T) {
	ctx := context.Background()
	st := storetest.New(t)
	at := time.Date(2024, 1, 1, 12, 0, 0, 0, time.UTC)
	external := fmt.Sprintf("%x", sha256.Sum256([]byte("conv-one\x00"+at.Format(time.RFC3339)+"\x00Alice\x00hello")))
	id, err := st.InsertMessage(ctx, store.Message{Source: "linkedin", ExternalID: external, ThreadID: "Same title", Body: "hello", SentAt: at})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "messages.csv")
	input := `CONVERSATION ID,CONVERSATION TITLE,FROM,TO,DATE,SUBJECT,CONTENT
conv-one,Same title,Alice,Me,2024-01-01 12:00:00 UTC,,hello
conv-two,Same title,Alice,Me,2024-01-01 12:00:00 UTC,,hello
`
	if err := os.WriteFile(path, []byte(input), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := Import(ctx, st, filepath.Join(dir, "archive"), path)
	if err != nil {
		t.Fatal(err)
	}
	if res.Inserted != 1 || res.Duplicates != 1 {
		t.Fatalf("result=%+v", res)
	}
	m, _, err := st.GetMessage(ctx, id)
	if err != nil || m.ThreadID != "conv-one" {
		t.Fatalf("old message=%+v, err=%v", m, err)
	}
	for _, thread := range []string{"conv-one", "conv-two"} {
		page, err := st.GetThread(ctx, "linkedin", thread, 0)
		if err != nil || len(page.Messages) != 1 {
			t.Fatalf("%s: %+v %v", thread, page, err)
		}
	}
}
