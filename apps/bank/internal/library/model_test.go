package library

import "testing"

func TestProvenanceRequiresContainedArchiveReference(t *testing.T) {
	for _, value := range []string{"/etc/passwd", `C:\Users\owner\secret`, `..\secret`, "source/../../secret", `\\server\share\secret`, "input:../secret"} {
		if err := (Provenance{RawRef: value}).Validate(); err == nil {
			t.Errorf("unsafe raw_ref accepted: %q", value)
		}
	}
	for _, value := range []string{"", `youtube\history.json`, "youtube/history.json", "input:watch-history.json"} {
		if err := (Provenance{RawRef: value}).Validate(); err != nil {
			t.Errorf("valid raw_ref %q: %v", value, err)
		}
	}
}
