package main

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/aquitano/aqt/apps/bank/internal/catalog"
	"github.com/aquitano/aqt/apps/bank/internal/library"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

type fakeReads struct {
	reads
	query string
	found catalog.Result
}

func (f *fakeReads) Find(_ context.Context, query string, _ store.SearchOpts, _ library.ListOptions) (catalog.Result, error) {
	f.query = query
	return f.found, nil
}

func TestMCPListsTheToolsAndSearchesWithRefs(t *testing.T) {
	ctx := t.Context()
	fake := &fakeReads{found: catalog.Result{Messages: []store.Message{{Ref: "0123456789ab", Source: "gmail", Sender: "alice", Body: "the lease", SentAt: time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)}}}}
	serverSide, clientSide := mcp.NewInMemoryTransports()
	if _, err := newMCPServer(fake).Connect(ctx, serverSide, nil); err != nil {
		t.Fatal(err)
	}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(ctx, clientSide, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()

	listed, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range listed.Tools {
		names = append(names, tool.Name)
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"message", "ref", "search", "thread", "timeline"}) {
		t.Fatalf("tools = %v", names)
	}

	called, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "search", Arguments: map[string]any{"query": "lease"}})
	if err != nil || called.IsError {
		t.Fatalf("search: %+v, %v", called, err)
	}
	var result catalog.Result
	raw, _ := json.Marshal(called.StructuredContent)
	if err := json.Unmarshal(raw, &result); err != nil || fake.query != "lease" || len(result.Messages) != 1 || result.Messages[0].Ref != "0123456789ab" {
		t.Fatalf("search result = %s, query %q, %v", raw, fake.query, err)
	}

	refused, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "timeline", Arguments: map[string]any{"period": "2026-03", "limit": -1}})
	if err != nil || !refused.IsError {
		t.Fatalf("timeline with a negative limit: %+v, %v", refused, err)
	}
}
