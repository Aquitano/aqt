package scan

import "github.com/aquitano/aqt/apps/bank/internal/attic/config"

func (r *run) rulesFor(file string) config.Rules {
	if r.folders != nil {
		return r.folders.For(file)
	}
	return r.rules
}
