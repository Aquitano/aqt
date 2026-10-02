package agent

import (
	"strings"

	"github.com/aquitano/aqt/apps/tracker/internal/client"
)

const defaultServerURL = "http://127.0.0.1:8490"

// Lists hold lowercase exe names, the bundle id of a Windows app. Ignore also
// holds window classes, for the shell surfaces explorer.exe draws: its
// taskbar and desktop take focus without attention, its file windows do not.
type Lists struct {
	Skip    map[string]bool
	Private map[string]bool
	Ignore  map[string]bool
}

var (
	// The extension already records what happens in a Chromium browser.
	defaultSkip = []string{"chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "arc.exe", "opera.exe", "chromium.exe"}

	defaultPrivate = []string{"1password.exe", "bitwarden.exe", "keepassxc.exe", "keepass.exe"}

	defaultIgnore = []string{
		"lockapp.exe", "searchhost.exe", "searchapp.exe", "startmenuexperiencehost.exe",
		"shellexperiencehost.exe", "shellhost.exe", "credentialuibroker.exe",
		"shell_traywnd", "shell_secondarytraywnd", "progman", "workerw",
		"xamlexplorerhostislandwindow", "multitaskingviewframe", "foregroundstaging",
		"notifyiconoverflowwindow", "toplevelwindowforoverflowxamlisland",
	}
)

type Config struct {
	ServerURL string
	// TokenPath is the CLI's session file; empty sends no token at all.
	TokenPath string
	Lists
}

// ConfigFromEnv reads the variables the macOS agent reads. An empty list or
// token path means none; an unset one keeps the default.
func ConfigFromEnv(lookup func(string) (string, bool)) (Config, error) {
	c := Config{ServerURL: defaultServerURL, Lists: Lists{
		Skip:    list(lookup, "TRACKER_SKIP_BUNDLE_IDS", defaultSkip),
		Private: list(lookup, "TRACKER_PRIVATE_BUNDLE_IDS", defaultPrivate),
		Ignore:  list(lookup, "TRACKER_IGNORE_BUNDLE_IDS", defaultIgnore),
	}}
	if url, _ := lookup("TRACKER_SERVER_URL"); url != "" {
		c.ServerURL = url
	}
	path, set := lookup("TRACKER_TOKEN_PATH")
	if !set {
		var err error
		if path, err = client.DefaultTokenPath(); err != nil {
			return Config{}, err
		}
	}
	c.TokenPath = path
	return c, nil
}

func list(lookup func(string) (string, bool), name string, def []string) map[string]bool {
	raw, set := lookup(name)
	entries := def
	if set {
		entries = strings.Split(raw, ",")
	}
	m := map[string]bool{}
	for _, e := range entries {
		if e = strings.ToLower(strings.TrimSpace(e)); e != "" {
			m[e] = true
		}
	}
	return m
}

func (l Lists) ignores(w Window) bool {
	return l.Ignore[w.App.ID] || l.Ignore[strings.ToLower(w.Class)]
}
