package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestReadReplacementMapAcceptsJSONAndCSV(t *testing.T) {
	want := map[string]string{"0123456789ab": "activity_ab", "ba9876543210": "collection_cd"}
	dir := t.TempDir()
	for name, content := range map[string]string{
		"map.json":       `{"0123456789ab":"activity_ab","ba9876543210":"collection_cd"}`,
		"map.csv":        "ref,replacement\n0123456789ab,activity_ab\nba9876543210, collection_cd\n",
		"headerless.csv": "0123456789ab,activity_ab\nba9876543210,collection_cd\n",
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
