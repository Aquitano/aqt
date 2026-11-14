package fieldhash_test

import (
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/fieldhash"
)

// Each pair joins to the same string with a NUL separator or none, the
// encodings a field could otherwise forge.
func TestFieldsThatJoinAlikeHashApart(t *testing.T) {
	for _, pair := range [][2][]string{
		{{"a\x00b", "c"}, {"a", "b\x00c"}},
		{{"ab", "c"}, {"a", "bc"}},
		{{"abc"}, {"abc", ""}},
		{{""}, {}},
	} {
		if a, b := fieldhash.Hex(pair[0]...), fieldhash.Hex(pair[1]...); a == b {
			t.Errorf("%q and %q both hash to %s", pair[0], pair[1], a)
		}
	}
	if got := fieldhash.Hex("source", "external_id", "1"); got != fieldhash.Hex("source", "external_id", "1") || len(got) != 64 {
		t.Errorf("Hex is not a stable 64-character digest: %s", got)
	}
}
