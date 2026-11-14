package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/tokens"
)

func TestThreadContextIncludesLateSearchHit(t *testing.T) {
	s, st := attachmentServer(t)
	ctx := context.Background()
	var messages []store.Message
	for i := range 2005 {
		messages = append(messages, store.Message{Source: "whatsapp", ExternalID: fmt.Sprint(i),
			ThreadID: "long-chat", Body: "message", SentAt: time.Unix(int64(i), 0)})
	}
	if _, err := st.InsertMessages(ctx, messages, store.InsertMessagesOpts{}); err != nil {
		t.Fatal(err)
	}
	target := ref.ForMessage("whatsapp", "", "2002").String()
	token, err := Tokens(s.dataDir).New("test", tokens.Write)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(s.Handler())
	defer srv.Close()
	status, body := authedGet(t, srv, token, "/v1/threads/long-chat?source=whatsapp&limit=20&around="+target)
	if status != 200 {
		t.Fatalf("%d: %s", status, body)
	}
	var thread store.Thread
	if err := json.Unmarshal([]byte(body), &thread); err != nil {
		t.Fatal(err)
	}
	for _, m := range thread.Messages {
		if m.Ref == target {
			return
		}
	}
	t.Fatalf("opened context lost search hit %s; returned %d messages starting at %s", target, len(thread.Messages), thread.Messages[0].Ref)
}
