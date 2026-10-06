package store

import (
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/disk"
)

func TestChooseVolume(t *testing.T) {
	data := Volume{ID: "data", PartitionID: "{29BE}", DeviceSerial: "WXF2"}
	clone := disk.Fingerprint{PartitionID: "{29BE}", DeviceSerial: "WX61"}
	cases := []struct {
		name      string
		fp        disk.Fingerprint
		known     []Volume
		want      string
		ambiguous bool
	}{
		{"unknown serial is a new volume", disk.Fingerprint{}, nil, "", false},
		{"same disk", disk.Fingerprint{PartitionID: "{29BE}", DeviceSerial: "WXF2"}, []Volume{data}, "data", false},
		{"bridge without a serial still matches", disk.Fingerprint{PartitionID: "{29BE}"}, []Volume{data}, "data", false},
		{"clone on another drive asks", clone, []Volume{data}, "", true},
		{"two fitting volumes ask", disk.Fingerprint{}, []Volume{data, {ID: "other"}}, "", true},
	}
	for _, tc := range cases {
		got, ambiguous := chooseVolume(tc.fp, tc.known)
		id := ""
		if got != nil {
			id = got.ID
		}
		if id != tc.want || ambiguous != tc.ambiguous {
			t.Errorf("%s: got %q ambiguous=%v, want %q ambiguous=%v", tc.name, id, ambiguous, tc.want, tc.ambiguous)
		}
	}
}
