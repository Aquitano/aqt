package aichat

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/importtest"
	"github.com/aquitano/aqt/apps/bank/internal/ingest"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
)

const branchedExport = `[{"conversation_id":"chat","title":"Branches","mapping":{
 "root":{"message":null},
 "q":{"parent":"root","message":{"id":"question","author":{"role":"user"},"content":{"parts":["Question"]},"create_time":1}},
 "a":{"parent":"q","message":{"id":"answer-a","author":{"role":"assistant"},"content":{"parts":["Original"]},"create_time":2}},
 "b":{"parent":"q","message":{"id":"answer-b","author":{"role":"assistant"},"content":{"parts":["Regenerated"]},"create_time":2}},
 "tool":{"parent":"b","message":{"id":"tool","author":{"role":"tool"},"content":{"parts":["Tool result"]}}},
 "follow":{"parent":"tool","message":{"id":"followup","author":{"role":"user"},"content":{"parts":["Continue"]},"create_time":3}}
}}]`

func TestChatGPTBranchesUseMessageIDsAndFollowStructuralParents(t *testing.T) {
	var convs []cgptConversation
	if err := json.Unmarshal([]byte(branchedExport), &convs); err != nil {
		t.Fatal(err)
	}
	messages := parseChatGPTConversation(convs[0])
	byID := map[string]message{}
	for _, m := range messages {
		byID[m.ExternalID] = m
	}
	if byID["answer-a"].ParentExternalID != "question" || byID["answer-b"].AlternativeIndex != 2 || byID["answer-a"].AlternativeIndex != 1 {
		t.Fatalf("alternatives: %+v", messages)
	}
	if byID["followup"].ParentExternalID != "answer-b" || byID["followup"].BranchID != "b" {
		t.Fatalf("followup: %+v", byID["followup"])
	}
	// Broken structural cycles terminate without inventing a reply target.
	convs[0].Mapping["cycle"] = cgptNode{Parent: "cycle"}
	if parent := chatGPTParent(convs[0].Mapping, "cycle"); parent != "" {
		t.Fatal(parent)
	}
}

func TestChatGPTBranchesImportAndReimport(t *testing.T) {
	target := importtest.Target(t, chatgptKind)
	st := target.Store
	ctx := context.Background()
	path := writeFile(t, t.TempDir(), "conversations.json", branchedExport)

	got := importtest.MustImport(t, target, "chatgpt", path, nil)
	if got.Report.Inserted != 4 || got.Status != "complete" {
		t.Fatalf("import: %+v", got)
	}
	cited := ref.ForMessage("chatgpt", "", "answer-b")
	branch, err := st.MessageBranch(ctx, cited)
	if err != nil {
		t.Fatal(err)
	}
	if branch.Incomplete || len(branch.Messages) != 2 || branch.Messages[0].ExternalID != "question" || branch.Messages[1].ExternalID != "answer-b" {
		t.Fatalf("branch includes another answer: %+v", branch)
	}
	parent, err := st.MessageParent(ctx, cited)
	if err != nil || parent.ExternalID != "question" {
		t.Fatalf("parent: %+v %v", parent, err)
	}

	again := importtest.MustImport(t, target, "chatgpt", path, nil)
	if again.Report.Inserted != 0 || again.Report.Duplicates != 4 {
		t.Fatalf("repeat: %+v", again.Report)
	}

	// A malformed input is still stored, and its failure recorded on it.
	bad := writeFile(t, t.TempDir(), "conversations.json", "not json")
	failed, err := importtest.Import(t, target, "chatgpt", bad, nil)
	if err == nil || failed.Status != "failed" {
		t.Fatalf("malformed input: %+v %v", failed, err)
	}
}

func TestChatGPTCompletenessReportKeepsMissingAndUnsupportedDetails(t *testing.T) {
	target := importtest.Target(t, chatgptKind)
	raw := `[{"id":"gaps","mapping":{"q":{"message":{"id":"question","author":{"role":"user"},"metadata":{"attachments":[{"id":"file-absent","name":"lost.pdf"}]},"content":{"parts":["Text",{"content_type":"unknown_widget","payload":42}]}}}}}]`
	path := writeFile(t, t.TempDir(), "conversations.json", raw)

	got := importtest.MustImport(t, target, "chatgpt", path, nil)
	r := got.Report
	if r.Inserted != 1 || r.Issues[ingest.MissingMedia] != 1 || r.Issues[ingest.Unsupported] != 1 || len(r.Details) != 2 || got.Status != "gaps" {
		t.Fatalf("import: %+v", got)
	}
}
