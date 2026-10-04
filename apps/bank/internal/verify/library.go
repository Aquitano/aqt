package verify

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

const CorruptRaw = "corrupt_raw"

func (v *verifier) libraryRecord(record store.ArchivedLibraryRecord) error {
	v.rep.LibraryRecordsChecked++
	finding := func(kind, detail string) {
		if record.Snapshot != "" {
			detail = "snapshot " + record.Snapshot + ": " + detail
		}
		v.add(Finding{LibraryID: record.ID, LibraryKind: record.Kind, Kind: kind, Detail: detail}, false)
	}
	for _, ref := range record.RawRefs {
		if ref == "" {
			continue
		}
		check, err := v.libraryRaw(ref)
		if err != nil {
			return err
		}
		if check.kind != "" {
			finding(check.kind, check.detail)
		}
	}
	if record.Kind != "file" {
		return nil
	}
	v.rep.LibraryFilesChecked++
	path := v.blobs.Path(record.SHA256)
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		finding(MissingBlob, "no bytes in the blob store")
		return nil
	}
	actual, err := hashFile(path)
	if err != nil {
		return err
	}
	if actual != record.SHA256 {
		finding(CorruptBlob, "content hashes to "+actual)
	} else if info.Size() != record.SizeBytes {
		finding(WrongSize, fmt.Sprintf("size_bytes says %d, file is %d", record.SizeBytes, info.Size()))
	}
	return nil
}

type libraryRawCheck struct{ kind, detail string }

func (v *verifier) libraryRaw(ref string) (libraryRawCheck, error) {
	if v.libraryRawChecks == nil {
		v.libraryRawChecks = map[string]libraryRawCheck{}
	}
	if checked, ok := v.libraryRawChecks[ref]; ok {
		return checked, nil
	}
	checked := libraryRawCheck{}
	path := v.rawFile(ref)
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		checked = libraryRawCheck{kind: MissingRaw, detail: ref}
	} else if expected, _, found := strings.Cut(filepath.Base(path), "-"); found && blob.ValidDigest(expected) == nil {
		actual, err := hashFile(path)
		if err != nil {
			return checked, err
		}
		if actual != expected {
			checked = libraryRawCheck{kind: CorruptRaw, detail: ref + ": content hashes to " + actual}
		}
	}
	v.libraryRawChecks[ref] = checked
	return checked, nil
}
