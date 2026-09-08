package all

import (
	"testing"

	"github.com/aquitano/aqt/apps/tracker/internal/extractor"
)

func TestRegistryListsEverySite(t *testing.T) {
	want := map[string]bool{"github": false, "x": false, "youtube": false}
	for _, rule := range extractor.Rules() {
		if _, ok := want[rule.Extractor]; !ok {
			continue
		}
		want[rule.Extractor] = true
		if rule.Version < 1 || len(rule.Hosts) == 0 || rule.PathRegex == "" {
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
