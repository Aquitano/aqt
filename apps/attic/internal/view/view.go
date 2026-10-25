// Package view shapes catalogue records for readers: every place says whether
// its disk is attached on this machine and how to open it. The CLI's --json
// output and the HTTP API both return these types, so the two never drift.
package view

import (
	"context"
	"path/filepath"
	"slices"
	"strings"

	"github.com/aquitano/aqt/apps/attic/internal/ai"
	"github.com/aquitano/aqt/apps/attic/internal/archive"
	"github.com/aquitano/aqt/apps/attic/internal/disk"
	"github.com/aquitano/aqt/apps/attic/internal/store"
)

// OnlineRoots maps each known volume that is attached right now to where it
// is mounted. A clone of a known disk does not light up the original.
func OnlineRoots(vols []store.Volume) map[string]string {
	return Roots(OnlineMounts(vols))
}

// OnlineMounts is OnlineRoots with each mount's fingerprint, so a caller can
// tell later whether the same disk is still there.
func OnlineMounts(vols []store.Volume) map[string]disk.Volume {
	mounts := map[string]disk.Volume{}
	for _, m := range disk.Mounted() {
		for _, v := range vols {
			if v.Holds(m.Fingerprint) {
				mounts[v.ID] = m
			}
		}
	}
	return mounts
}

func Roots(mounts map[string]disk.Volume) map[string]string {
	roots := make(map[string]string, len(mounts))
	for id, m := range mounts {
		roots[id] = m.Root
	}
	return roots
}

// DisplayPath spells an entry the way it can be opened right now, or names
// its volume when the disk is not attached.
func DisplayPath(volumeID, label, p string, roots map[string]string) string {
	rel := filepath.FromSlash(strings.TrimPrefix(p, "/"))
	if root, ok := roots[volumeID]; ok {
		return filepath.Join(root, rel)
	}
	if label == "" && len(volumeID) >= 8 {
		label = volumeID[:8]
	}
	return label + ":" + string(filepath.Separator) + rel
}

// Place is one entry, with the path spelled for opening.
type Place struct {
	store.Hit
	Display string `json:"display" doc:"Path to open on the machine serving the catalogue, or label:\\path while the disk is detached."`
	Online  bool   `json:"online" doc:"Whether the entry's disk is attached to that machine now."`
}

func Places(hits []store.Hit, roots map[string]string) []Place {
	out := make([]Place, len(hits))
	for i, h := range hits {
		_, online := roots[h.VolumeID]
		out[i] = Place{Hit: h, Display: DisplayPath(h.VolumeID, h.Volume, h.Path, roots), Online: online}
	}
	return out
}

// BestCopy is the copy to show: one that holds the content and can be opened
// now, or the first present one, as occurrences sorts them.
func BestCopy(copies []Place) Place {
	if len(copies) == 0 {
		return Place{}
	}
	return copies[max(slices.IndexFunc(copies, func(p Place) bool {
		return p.Online && !p.Missing && p.Version != store.VersionPrevious
	}), 0)]
}

// TextMatch is a document hit, shown at its best copy.
type TextMatch struct {
	store.TextHit
	Display string  `json:"display" doc:"Path of the best copy: attached, present and current where possible."`
	Online  bool    `json:"online"`
	Places  []Place `json:"places" doc:"Every place the content lives or lived, present copies first."`
	Shown   Place   `json:"-"`
}

func TextMatches(texts []store.TextHit, roots map[string]string) []TextMatch {
	out := make([]TextMatch, len(texts))
	for i, t := range texts {
		places := Places(t.Places, roots)
		shown := BestCopy(places)
		out[i] = TextMatch{TextHit: t, Display: shown.Display, Online: shown.Online, Places: places, Shown: shown}
	}
	return out
}

// MemberMatch is a file inside an archive, shown inside the copy of its
// archive that can be opened now, or the first present one.
type MemberMatch struct {
	store.MemberHit
	Display string  `json:"display" doc:"Path of the archive's best copy, then the member's path inside it."`
	Online  bool    `json:"online"`
	Archive []Place `json:"archive" doc:"Every place the archive lives, present copies first."`
	Shown   Place   `json:"-"`
}

func MemberMatches(members []store.MemberHit, roots map[string]string) []MemberMatch {
	out := make([]MemberMatch, len(members))
	for i, m := range members {
		copies := Places(m.Archive, roots)
		out[i] = MemberMatch{MemberHit: m, Archive: copies}
		if len(copies) == 0 {
			continue
		}
		shown := BestCopy(copies)
		out[i].Shown = shown
		out[i].Display = shown.Display + archive.Separator + filepath.FromSlash(m.Path)
		out[i].Online = shown.Online
	}
	return out
}

// AnalysisMatch is an OCR or image-description hit with the model that wrote it.
type AnalysisMatch struct {
	TextMatch
	ai.Key
}

func AnalysisMatches(hits []store.AIHit, roots map[string]string) []AnalysisMatch {
	out := make([]AnalysisMatch, len(hits))
	for i, h := range hits {
		out[i] = AnalysisMatch{TextMatch: TextMatches([]store.TextHit{h.TextHit}, roots)[0], Key: h.Key}
	}
	return out
}

// SearchResult keeps each index's hits apart: every BM25 index scores on its
// own scale, so merging them into one ranking would be meaningless.
type SearchResult struct {
	Entries  []Place         `json:"entries" doc:"Files, folders and links whose name or path matches."`
	Members  []MemberMatch   `json:"members" doc:"Files and folders inside archives."`
	Texts    []TextMatch     `json:"texts" doc:"Documents whose extracted text matches."`
	Metadata []TextMatch     `json:"metadata" doc:"Files whose embedded tags match."`
	Analyses []AnalysisMatch `json:"analyses" doc:"Files whose OCR or image description matches."`
}

func Search(ctx context.Context, st *store.Store, o store.SearchOptions, roots map[string]string) (SearchResult, error) {
	hits, err := st.Search(ctx, o)
	if err != nil {
		return SearchResult{}, err
	}
	members, err := st.SearchMembers(ctx, o)
	if err != nil {
		return SearchResult{}, err
	}
	texts, err := st.SearchTexts(ctx, o)
	if err != nil {
		return SearchResult{}, err
	}
	meta, err := st.SearchMetadata(ctx, o)
	if err != nil {
		return SearchResult{}, err
	}
	analyses, err := st.SearchAI(ctx, o)
	if err != nil {
		return SearchResult{}, err
	}
	return SearchResult{
		Entries: Places(hits, roots), Members: MemberMatches(members, roots), Texts: TextMatches(texts, roots),
		Metadata: TextMatches(meta, roots), Analyses: AnalysisMatches(analyses, roots),
	}, nil
}

// Content is one unique content and every place it lives or lived.
type Content struct {
	store.ContentDetail
	Occurrences []Place `json:"occurrences" doc:"Current places first, then places that held this content before their bytes changed."`
}

func NewContent(c store.ContentDetail, roots map[string]string) Content {
	return Content{ContentDetail: c, Occurrences: Places(c.Occurrences, roots)}
}

// Entry is one entry with its path spelled for opening and the other places
// its content lives.
type Entry struct {
	store.EntryDetail
	Display string  `json:"display"`
	Online  bool    `json:"online"`
	Copies  []Place `json:"copies,omitempty" doc:"Other places that hold the same content."`
}

func NewEntry(d store.EntryDetail, roots map[string]string) Entry {
	_, online := roots[d.VolumeID]
	return Entry{EntryDetail: d, Display: DisplayPath(d.VolumeID, d.Volume, d.Path, roots), Online: online, Copies: Places(d.Copies, roots)}
}

// VolumeStatus is a volume's totals and where it is attached now.
type VolumeStatus struct {
	store.VolumeSummary
	MountedAt string `json:"mounted_at,omitempty" doc:"Where the volume is attached on the machine serving the catalogue; empty while detached."`
}

func VolumeStatuses(vols []store.VolumeSummary) []VolumeStatus {
	known := make([]store.Volume, len(vols))
	for i, v := range vols {
		known[i] = v.Volume
	}
	roots := OnlineRoots(known)
	out := make([]VolumeStatus, len(vols))
	for i, v := range vols {
		out[i] = VolumeStatus{v, roots[v.ID]}
	}
	return out
}

// DupeGroup is one content stored more than once, with every copy.
type DupeGroup struct {
	store.Dupe
	Places []Place `json:"places"`
}

type DupeReport struct {
	Wasted int64       `json:"wasted" doc:"Bytes that every copy beyond the first occupies, over all groups."`
	Dupes  []DupeGroup `json:"dupes" doc:"Largest waste first."`
}

func NewDupeReport(dupes []store.Dupe, wasted int64, roots map[string]string) DupeReport {
	out := DupeReport{Wasted: wasted, Dupes: make([]DupeGroup, len(dupes))}
	for i, d := range dupes {
		out.Dupes[i] = DupeGroup{d, Places(d.Places, roots)}
	}
	return out
}

// Stats is the whole catalogue in numbers.
type Stats struct {
	store.Totals
	Analyses map[string]int64 `json:"analyses" doc:"Enrichment results by task and provider."`
}

// SkipReport is what one scan left out, grouped by reason and rule.
type SkipReport struct {
	Scan   store.ScanInfo    `json:"scan"`
	Groups []store.SkipGroup `json:"groups"`
}
