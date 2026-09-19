package aichat

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/store"
	"github.com/aquitano/aqt/apps/bank/internal/storetest"
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
	messages := parseChatGPTConversation(convs[0], true)
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

func TestChatGPTReimportHealsBranchesAndKeepsReports(t *testing.T) {
	st := storetest.New(t)
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "conversations.json")
	if err := os.WriteFile(path, []byte(branchedExport), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := st.InsertMessage(ctx, store.Message{Source: "chatgpt", ExternalID: "answer-b", ThreadID: "chat", Body: "Keep repaired body"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := ImportChatGPT(ctx, st, newBlobs(t), filepath.Join(dir, "archive"), path)
	if err != nil {
		t.Fatal(err)
	}
	if result.Inserted != 3 || result.Duplicates != 1 {
		t.Fatalf("result: %+v", result)
	}
	id, err := st.FindMessageID(ctx, "chatgpt", "answer-b")
	if err != nil {
		t.Fatal(err)
	}
	m, _, err := st.GetMessage(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if m.ParentExternalID != "question" || m.AlternativeIndex != 2 || m.BranchID != "b" || m.Body != "Keep repaired body" {
		t.Fatalf("message: %+v", m)
	}
	branch, err := st.MessageBranch(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if branch.Incomplete || len(branch.Messages) != 2 || branch.Messages[0].ExternalID != "question" || branch.Messages[1].ExternalID != "answer-b" {
		t.Fatalf("branch includes another answer: %+v", branch)
	}
	parent, err := st.MessageParent(ctx, id)
	if err != nil || parent.ExternalID != "question" {
		t.Fatalf("parent: %+v %v", parent, err)
	}
	if _, err := ImportChatGPT(ctx, st, newBlobs(t), filepath.Join(dir, "archive"), path); err != nil {
		t.Fatal(err)
	}
	reports, err := st.ImportReports(ctx, 0, 50)
	if err != nil || len(reports) != 2 {
		t.Fatalf("reports: %+v %v", reports, err)
	}
	var counters struct {
		Inserted   int `json:"inserted"`
		Duplicates int `json:"duplicates"`
	}
	if err := json.Unmarshal(reports[0].Result, &counters); err != nil {
		t.Fatal(err)
	}
	if counters.Inserted != 0 || counters.Duplicates != 4 {
		t.Fatalf("repeat: %+v", counters)
	}
	// A malformed input is also retained after failure.
	if err := os.WriteFile(path, []byte("not json"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ImportChatGPT(ctx, st, newBlobs(t), filepath.Join(dir, "archive"), path); err == nil {
		t.Fatal("expected malformed input error")
	}
	reports, err = st.ImportReports(ctx, 0, 50)
	if err != nil || len(reports) != 3 || reports[0].Status != "failed" {
		t.Fatalf("reports: %+v %v", reports, err)
	}
}

func TestChatGPTCompletenessReportKeepsMissingAndUnsupportedDetails(t *testing.T) {
	st := storetest.New(t)
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "conversations.json")
	raw := `[{"id":"gaps","mapping":{"q":{"message":{"id":"question","author":{"role":"user"},"metadata":{"attachments":[{"id":"file-absent","name":"lost.pdf"}]},"content":{"parts":["Text",{"content_type":"unknown_widget","payload":42}]}}}}}]`
	if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := ImportChatGPT(ctx, st, newBlobs(t), filepath.Join(dir, "archive"), path)
	if err != nil {
		t.Fatal(err)
	}
	if result.Inserted != 1 || result.MissingMedia != 1 || result.UnsupportedContent != 1 {
		t.Fatalf("result: %+v", result)
	}
	reports, err := st.ImportReports(ctx, 0, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(reports) != 1 || reports[0].Status != "gaps" {
		t.Fatalf("reports: %+v", reports)
	}
	var saved struct {
		Issues      []string `json:"issues"`
		Missing     int      `json:"missing_media"`
		Unsupported int      `json:"unsupported_content"`
	}
	if err := json.Unmarshal(reports[0].Result, &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved.Issues) != 2 || saved.Missing != 1 || saved.Unsupported != 1 {
		t.Fatalf("saved: %+v", saved)
	}
}
