package search

import (
	"slices"
	"time"

	"github.com/aquitano/aqt/apps/bank/internal/fail"
)

// Filters narrow a search. Each kind applies the ones it has; a search leaves
// out the kinds that cannot apply one that is set, and says so in coverage.
type Filters struct {
	// Kind is a hit kind, or a library record's kind such as movie or watch.
	Kind    string
	Source  string
	Account string
	// Since is inclusive and Until exclusive.
	Since, Until time.Time
	// The rest apply to messages only.
	Thread string
	From   string
	To     string
	// Person is a contact's name; Participants are its identity keys, as
	// messages.participants holds them, which the caller resolves.
	Person        string
	Participants  []string
	MailboxID     int64
	Subject       string
	HasAttachment *bool
}

var (
	ItemKinds       = []string{"video", "movie", "series", "episode", "track", "album", "podcast", "book", "article", "other"}
	ActivityKinds   = []string{"watch", "listen", "read", "play", "view", "purchase", "other"}
	CollectionKinds = []string{"playlist", "library", "watchlist", "list"}
	HitKinds        = []string{KindMessage, KindFile, KindItem, KindActivity, KindCollection, KindPage}
)

func (f Filters) Validate() error {
	if f.Kind != "" && !slices.Contains(HitKinds, f.Kind) && !slices.Contains(ItemKinds, f.Kind) &&
		!slices.Contains(ActivityKinds, f.Kind) && !slices.Contains(CollectionKinds, f.Kind) {
		return fail.Invalidf("unsupported kind %q", f.Kind)
	}
	if f.MailboxID < 0 || (f.MailboxID != 0 && f.Source == "") {
		return fail.Invalidf("mailbox_id must be positive and requires a source")
	}
	if !f.Since.IsZero() && !f.Until.IsZero() && !f.Until.After(f.Since) {
		return fail.Invalidf("--until must be after --since")
	}
	return nil
}

// MessageScoped reports a filter only messages have. Files then count only
// through the messages they are attached to.
func (f Filters) MessageScoped() bool {
	return f.Thread != "" || f.From != "" || f.To != "" || f.Person != "" || f.MailboxID != 0 ||
		f.Subject != "" || f.HasAttachment != nil
}

func (f Filters) Dated() bool { return !f.Since.IsZero() || !f.Until.IsZero() }

// Wants reports whether the kind filter admits hits of kind, and for a
// library kind, records of type.
func (f Filters) Wants(kind string) bool {
	switch {
	case f.Kind == "" || f.Kind == kind:
		return true
	case kind == KindItem:
		return slices.Contains(ItemKinds, f.Kind)
	case kind == KindActivity:
		return slices.Contains(ActivityKinds, f.Kind)
	case kind == KindCollection:
		return slices.Contains(CollectionKinds, f.Kind)
	}
	return false
}

// Subkind is the library record kind the filter names, or "".
func (f Filters) Subkind() string {
	if slices.Contains(HitKinds, f.Kind) {
		return ""
	}
	return f.Kind
}
