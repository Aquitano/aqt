package eml

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestMailTreePreservesFolderIdentity(t *testing.T) {
	for _, layout := range []string{"eml", "thunderbird"} {
		t.Run(layout, func(t *testing.T) {
			root := t.TempDir()
			paths := []string{"Work!/mail.eml", "Work/mail.eml", "work/mail.eml", "index.msf"}
			want := []string{"Work", "Work!", "work"}
			if layout == "thunderbird" {
				paths = []string{"Work", "Work.sbd/Receipts", "Work.msf", "Work.sbd/Receipts.msf"}
				want = []string{"Work", "Work/Receipts"}
			}
			for _, relative := range paths {
				name := filepath.Join(root, filepath.FromSlash(relative))
				if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(name, []byte("fixture"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			var got []string
			err := WalkMailTree(root, layout, func(_, _ string, observation MailImportContext) error {
				got = append(got, observation.Mailbox)
				return nil
			}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) == 2 && layout == "eml" {
				want = []string{"Work", "Work!"}
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("folders = %v, want %v", got, want)
			}
		})
	}
}
