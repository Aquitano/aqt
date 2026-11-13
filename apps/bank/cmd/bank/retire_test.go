package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestReadReplacementMapAcceptsJSONAndCSV(t *testing.T) {
	want := map[string]string{"msg:0123456789abcdef": "activity:ab", "msg:fedcba9876543210": "collection:cd"}
	dir := t.TempDir()
	for name, content := range map[string]string{
		"map.json":       `{"msg:0123456789abcdef":"activity:ab","msg:fedcba9876543210":"collection:cd"}`,
		"map.csv":        "ref,replacement\nmsg:0123456789abcdef,activity:ab\nmsg:fedcba9876543210, collection:cd\n",
		"headerless.csv": "msg:0123456789abcdef,activity:ab\nmsg:fedcba9876543210,collection:cd\n",
	} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		got, err := readReplacementMap(path)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %v %v", name, got, err)
		}
	}
}

func TestReadReplacementMapKeepsAMalformedFirstRef(t *testing.T) {
	path := filepath.Join(t.TempDir(), "typo.csv")
	if err := os.WriteFile(path, []byte("msg:0123456789abcdef0,activity:ab\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readReplacementMap(path)
	if err != nil || got["msg:0123456789abcdef0"] != "activity:ab" {
		t.Fatalf("a typo in the first ref must reach validation, not pass as a header: %v %v", got, err)
	}
}
