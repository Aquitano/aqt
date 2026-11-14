package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/aquitano/aqt/apps/bank/internal/client"
	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/server"
	"github.com/aquitano/aqt/apps/bank/internal/sources"
)

type mcpCmd struct{}

func (mcpCmd) Run(ctx context.Context) error {
	api, closeAPI, err := connect(ctx)
	if err != nil {
		return err
	}
	defer closeAPI()
	s, err := newMCPServer(server.Document(sources.All), api)
	if err != nil {
		return err
	}
	return s.Run(ctx, &mcp.StdioTransport{})
}

var mcpInstructions = fmt.Sprintf(`bank is one person's archive: mail, chats and AI conversations, a media library with what was watched, listened to and read, stored files and published notes, and a catalogue of the files on disks.

Every record that can be cited has one ref, kind:value: msg:<16 hex> for a message, content:<16 to 64 hex> for bytes, and a library ID such as item:<32 hex>. Cite refs exactly as the tools return them.

Start with %s, which returns one ranked list of small hits, each with its ref and a snippet but never a whole body. %s says what a ref names and where the same bytes are. Then read the record: %s for a message, %s with a hit's thread_id, source and ref as around for its conversation, and %s for the text read from a file.`,
	server.Search.ID, server.ResolveRef.ID, server.GetMessage.ID, server.GetThread.ID, server.GetDiskContentText.ID)

// newMCPServer offers each operation of doc that is marked as a tool, and
// calls it through api.
func newMCPServer(doc *huma.OpenAPI, api *client.Client) (*mcp.Server, error) {
	s := mcp.NewServer(&mcp.Implementation{Name: "bank", Version: buildVersion()}, &mcp.ServerOptions{Instructions: mcpInstructions})
	for _, path := range slices.Sorted(maps.Keys(doc.Paths)) {
		item := doc.Paths[path]
		for _, op := range []*huma.Operation{item.Get, item.Put, item.Post, item.Delete, item.Patch} {
			if op == nil || op.Extensions[httpapi.ToolExtension] != true {
				continue
			}
			tool, err := toolFor(op, doc.Components.Schemas)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", op.OperationID, err)
			}
			s.AddTool(tool, callTool(api, op, tool.OutputSchema != nil))
		}
	}
	return s, nil
}

// toolFor describes op as a tool: its path and query parameters, and its
// body as body, are the arguments, with the schemas Huma generated for them.
// Only an answer that is a JSON object has an output schema, because clients
// before the 2026-07-28 revision of MCP accept no other structured content.
func toolFor(op *huma.Operation, components huma.Registry) (*mcp.Tool, error) {
	input := &huma.Schema{Type: huma.TypeObject, Properties: map[string]*huma.Schema{}, AdditionalProperties: false}
	for _, p := range op.Parameters {
		if p.In != "path" && p.In != "query" {
			return nil, fmt.Errorf("parameter %s is in the %s, which a tool cannot send", p.Name, p.In)
		}
		input.Properties[p.Name] = p.Schema
		if p.Required {
			input.Required = append(input.Required, p.Name)
		}
	}
	if op.RequestBody != nil {
		input.Properties["body"] = op.RequestBody.Content["application/json"].Schema
		if op.RequestBody.Required {
			input.Required = append(input.Required, "body")
		}
	}
	inputSchema, err := standalone(input, components)
	if err != nil {
		return nil, err
	}
	tool := &mcp.Tool{Name: op.OperationID, Description: strings.TrimSpace(op.Summary + "\n\n" + op.Description), InputSchema: inputSchema,
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !httpapi.Writes(op)}}
	if out := success(op, components); out != nil && out.Type == huma.TypeObject {
		if tool.OutputSchema, err = standalone(out, components); err != nil {
			return nil, err
		}
	}
	return tool, nil
}

func success(op *huma.Operation, components huma.Registry) *huma.Schema {
	for _, status := range slices.Sorted(maps.Keys(op.Responses)) {
		if media := op.Responses[status].Content["application/json"]; strings.HasPrefix(status, "2") && media != nil {
			if media.Schema.Ref != "" {
				return components.SchemaFromRef(media.Schema.Ref)
			}
			return media.Schema
		}
	}
	return nil
}

var componentRef = regexp.MustCompile(`"#/components/schemas/([^"]+)"`)

// standalone is schema with the components it refers to under $defs, since a
// tool's schema has no document around it.
func standalone(schema *huma.Schema, components huma.Registry) (json.RawMessage, error) {
	root, err := json.Marshal(schema)
	if err != nil {
		return nil, err
	}
	defs := map[string]json.RawMessage{}
	for pending := [][]byte{root}; len(pending) > 0; pending = pending[1:] {
		for _, m := range componentRef.FindAllSubmatch(pending[0], -1) {
			name := string(m[1])
			if _, seen := defs[name]; seen {
				continue
			}
			if defs[name], err = json.Marshal(components.Map()[name]); err != nil {
				return nil, err
			}
			pending = append(pending, defs[name])
		}
	}
	var whole map[string]json.RawMessage
	if err := json.Unmarshal(root, &whole); err != nil {
		return nil, err
	}
	if len(defs) > 0 {
		if whole["$defs"], err = json.Marshal(defs); err != nil {
			return nil, err
		}
	}
	out, err := json.Marshal(whole)
	return json.RawMessage(componentRef.ReplaceAll(out, []byte(`"#/$$defs/$1"`))), err
}

// callTool calls op through api with a tool call's arguments. Its answer is
// the tool's result; a failure is a tool error holding the tagged JSON the
// API answered with.
func callTool(api *client.Client, op *huma.Operation, structured bool) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		answer, err := send(ctx, api, op, req.Params.Arguments)
		if err != nil {
			return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: failureText(err)}}}, nil
		}
		result := &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(answer)}}}
		if structured {
			result.StructuredContent = answer
		}
		return result, nil
	}
}

func send(ctx context.Context, api *client.Client, op *huma.Operation, arguments json.RawMessage) (json.RawMessage, error) {
	var args map[string]json.RawMessage
	if len(arguments) > 0 {
		if err := json.Unmarshal(arguments, &args); err != nil {
			return nil, httpapi.Invalid.New("the arguments are not a JSON object")
		}
	}
	path, query := op.Path, url.Values{}
	for _, p := range op.Parameters {
		raw, ok := args[p.Name]
		if !ok || string(raw) == "null" {
			if p.In == "path" {
				return nil, httpapi.Invalid.New(p.Name + " is required")
			}
			continue
		}
		text, err := parameter(raw)
		if err != nil {
			return nil, httpapi.Invalid.New(p.Name + ": " + err.Error())
		}
		if p.In == "path" {
			path = strings.Replace(path, "{"+p.Name+"}", url.PathEscape(text), 1)
		} else {
			query.Set(p.Name, text)
		}
	}
	return api.Do(ctx, op.Method, path, query, args["body"])
}

// parameter writes an argument the way Huma reads a parameter: a string as
// it is, a number or boolean as JSON writes it, and a list joined by commas.
func parameter(raw json.RawMessage) (string, error) {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text, nil
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) == nil {
		texts := make([]string, len(items))
		for i, item := range items {
			var err error
			if texts[i], err = parameter(item); err != nil {
				return "", err
			}
		}
		return strings.Join(texts, ","), nil
	}
	if strings.HasPrefix(string(raw), "{") {
		return "", errors.New("an object is not a parameter")
	}
	return string(raw), nil
}

// failureText is a failure as the API answers it: tagged JSON, with
// recovery where the caller can act.
func failureText(err error) string {
	if answered, ok := errors.AsType[*client.Error](err); ok && answered.Body != nil {
		return string(answered.Body)
	}
	if invalid, ok := errors.AsType[*httpapi.Error](err); ok {
		if b, err := json.Marshal(invalid); err == nil {
			return string(b)
		}
	}
	return err.Error()
}
