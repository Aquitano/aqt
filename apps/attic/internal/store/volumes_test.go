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
		{"bridge without a serial asks", disk.Fingerprint{PartitionID: "{29BE}"}, []Volume{data}, "", true},
		{"clone on another drive asks", clone, []Volume{data}, "", true},
		{"unrecorded device serial asks", disk.Fingerprint{DeviceSerial: "WXF2"}, []Volume{{ID: "old"}}, "", true},
		{"both device serials absent ask", disk.Fingerprint{}, []Volume{{ID: "old"}}, "", true},
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

func TestVolumeHoldsWithoutDeviceSerial(t *testing.T) {
	v := Volume{DeviceSerial: "known"}
	if !v.Holds(disk.Fingerprint{}) {
		t.Fatal("a missing serial prevents reading an explicitly selected volume")
	}
}
