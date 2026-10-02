package all

import (
	"slices"
	"testing"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
)

func TestRegistryListsEverySite(t *testing.T) {
	want := map[string]bool{"article": false, "github": false, "hackernews": false, "reddit": false, "x": false, "youtube": false}
	for _, rule := range extractor.Rules() {
		if _, ok := want[rule.Extractor]; !ok {
			continue
		}
		want[rule.Extractor] = true
		// The wildcard fallback reads every path there is, so it carries no regex.
		fallback := slices.Contains(rule.Hosts, "*")
		if rule.Version < 1 || len(rule.Hosts) == 0 || (rule.PathRegex == "" && !fallback) {
			t.Errorf("%s has an incomplete rule: %+v", rule.Extractor, rule)
		}
		if rule.DwellMS == 0 || rule.MaxBytes == 0 || rule.Recapture == "" {
			t.Errorf("%s is missing rule defaults: %+v", rule.Extractor, rule)
		}
	}
	for name, found := range want {
		if !found {
			t.Errorf("%s is not registered", name)
		}
	}
}
