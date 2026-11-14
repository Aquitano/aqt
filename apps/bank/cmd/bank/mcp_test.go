package main

import (
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/sources"
)

// mcpSession is an MCP client of bank mcp's server over api, in memory.
func mcpSession(t *testing.T, api *client.Client) *mcp.ClientSession {
	t.Helper()
	s, err := newMCPServer(server.Document(sources.All), api)
	if err != nil {
		t.Fatal(err)
	}
	serverSide, clientSide := mcp.NewInMemoryTransports()
	if _, err := s.Connect(t.Context(), serverSide, nil); err != nil {
		t.Fatal(err)
	}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "test"}, nil).Connect(t.Context(), clientSide, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { session.Close() })
	return session
}

func TestToolsAreTheFlaggedReadOperations(t *testing.T) {
	doc := server.Document(sources.All)
	var flagged []string
	for _, item := range doc.Paths {
		for _, op := range []*huma.Operation{item.Get, item.Put, item.Post, item.Delete, item.Patch} {
			if op != nil && op.Extensions[httpapi.ToolExtension] == true {
				flagged = append(flagged, op.OperationID)
				if httpapi.Writes(op) {
					t.Errorf("%s writes and is a tool", op.OperationID)
				}
			}
		}
	}
	listed, err := mcpSession(t, client.New("http://unused", "")).ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	tools := map[string]*mcp.Tool{}
	for _, tool := range listed.Tools {
		tools[tool.Name] = tool
	}
	if got := slices.Sorted(maps.Keys(tools)); !slices.Equal(got, slices.Sorted(slices.Values(flagged))) || len(got) == 0 {
		t.Fatalf("tools %v, want the flagged operations %v", got, flagged)
	}

	var input struct {
		Properties map[string]struct {
			Description string `json:"description"`
			Default     any    `json:"default"`
			Minimum     *int   `json:"minimum"`
			Maximum     *int   `json:"maximum"`
		} `json:"properties"`
		Required []string `json:"required"`
	}
	b, err := json.Marshal(tools[server.Search.ID].InputSchema)
	if err != nil || json.Unmarshal(b, &input) != nil {
		t.Fatal(err)
	}
	limit := input.Properties["limit"]
	if limit.Description != "How many results, at most." || limit.Default != float64(20) || *limit.Minimum != 1 || *limit.Maximum != 500 ||
		!slices.Equal(input.Required, []string{"q"}) || !strings.Contains(input.Properties["q"].Description, "quoted phrases") {
		t.Errorf("search's input schema lost its documentation or bounds: %s", b)
	}

	spec, err := server.Spec(sources.All)
	if err != nil || !strings.Contains(string(spec), `"`+httpapi.ToolExtension+`": true`) {
		t.Errorf("the OpenAPI document does not mark tools with %s", httpapi.ToolExtension)
	}
}

func TestToolCallsAnswerAsTheAPIDoes(t *testing.T) {
	_, _, remote := archive(t)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, remote.URL+"/v1/search?q=lunch", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("BANK_TOKEN"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	route, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/search: %d %v", resp.StatusCode, err)
	}

	inProcess, closeAPI, err := connect(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer closeAPI()
	for name, api := range map[string]*client.Client{"in process": inProcess, "over HTTP": client.New(remote.URL, os.Getenv("BANK_TOKEN"))} {
		session := mcpSession(t, api)
		call := func(tool string, args map[string]any) *mcp.CallToolResult {
			result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: tool, Arguments: args})
			if err != nil {
				t.Fatalf("%s: %s: %v", name, tool, err)
			}
			return result
		}
		found := call(server.Search.ID, map[string]any{"q": "lunch"})
		structured, err := json.Marshal(found.StructuredContent)
		if err != nil || found.IsError || !jsonEqual(t, structured, route) || !jsonEqual(t, []byte(found.Content[0].(*mcp.TextContent).Text), route) {
			t.Errorf("%s: search answered %s, the route %s", name, structured, route)
		}
		for tool, tc := range map[string]struct {
			args map[string]any
			tag  string
		}{
			server.Search.ID:     {map[string]any{"q": "lunch", "limit": 0}, httpapi.Invalid.Tag},
			server.GetMessage.ID: {map[string]any{"ref": "msg:ffffffffffffffff"}, httpapi.NotFound.Tag},
		} {
			result := call(tool, tc.args)
			var failure struct {
				Tag string `json:"_tag"`
			}
			text := result.Content[0].(*mcp.TextContent).Text
			if !result.IsError || json.Unmarshal([]byte(text), &failure) != nil || failure.Tag != tc.tag {
				t.Errorf("%s: %s %v answered %s, want a tool error tagged %s", name, tool, tc.args, text, tc.tag)
			}
		}
	}
}

func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &y); err != nil {
		t.Fatal(err)
	}
	return reflect.DeepEqual(x, y)
}
