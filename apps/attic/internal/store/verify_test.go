package store_test

import (
	"testing"

	"github.com/aquitano/aqt/apps/attic/internal/store"
)

func TestVerificationResolvesCatalogueSpelling(t *testing.T) {
	st, conn := searchFixture(t)
	const volume = "00000000-0000-0000-0000-000000000001"
	_, err := conn.Exec(t.Context(), `
 insert into entries(id,volume_id,parent_id,kind,name,raw_name,path,hash_state,first_scan,updated_scan,missing_scan)
 overriding system value values
 (7,'00000000-0000-0000-0000-000000000001',1,'dir','Files','Files'::bytea,'/Files','none',1,1,null),
 (8,'00000000-0000-0000-0000-000000000001',7,'dir','Archive','Archive'::bytea,'/Files/Archive','none',1,1,1),
 (9,'00000000-0000-0000-0000-000000000001',8,'file','a.txt','a.txt'::bytea,'/Files/Archive/a.txt','pending',1,1,1)`)
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{"/Files/Archive", "/fIlEs/archive"} {
		under, err := st.ResolveVerificationPath(t.Context(), volume, input)
		if err != nil || under != "/Files/Archive" {
			t.Fatalf("scope %q: %q, %v", input, under, err)
		}
		var files []store.VerifyFile
		err = st.WalkVerification(t.Context(), volume, under, func(f store.VerifyFile) error {
			files = append(files, f)
			return nil
		})
		if err != nil || len(files) != 1 || files[0].Path != "/Files/Archive/a.txt" || !files[0].Missing {
			t.Fatalf("missing files for %q: %+v, %v", input, files, err)
		}
	}
	for _, input := range []string{"", "/Files/absent"} {
		if got, err := st.ResolveVerificationPath(t.Context(), volume, input); err != nil || got != input {
			t.Fatalf("scope %q: %q, %v", input, got, err)
		}
	}
	_, err = conn.Exec(t.Context(), `
 insert into entries(id,volume_id,parent_id,kind,name,raw_name,path,hash_state,first_scan,updated_scan)
 overriding system value values(10,'00000000-0000-0000-0000-000000000001',7,'dir','archive','archive'::bytea,'/Files/archive','none',1,1)`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.ResolveVerificationPath(t.Context(), volume, "/Files/ARCHIVE"); err == nil {
		t.Fatal("accepted ambiguous catalogue spelling")
	}
	if got, err := st.ResolveVerificationPath(t.Context(), volume, "/Files/Archive"); err != nil || got != "/Files/Archive" {
		t.Fatalf("exact spelling: %q, %v", got, err)
	}
}
