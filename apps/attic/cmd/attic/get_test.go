package main

import "testing"

func TestGetArguments(t *testing.T) {
	var root cli
	if _, err := parseCLI(&root, []string{"get", "attic:0123456789abcdef", "--to", "recovered.pdf", "--json"}); err != nil {
		t.Fatal(err)
	}
	if root.Get.To != "recovered.pdf" || !root.Get.JSON {
		t.Fatalf("parsed: %+v", root.Get)
	}
	for _, args := range [][]string{{"get", "123"}, {"get", "123", "456", "--to", "file"}, {"get", "123", "--to", "file", "--force"}} {
		if _, err := parseCLI(&cli{}, args); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}
