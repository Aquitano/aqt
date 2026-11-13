package catalog

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	atticstore "github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
	"github.com/aquitano/aqt/apps/bank/internal/content"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// ErrNoRecord means a ref is well formed and names nothing.
var ErrNoRecord = errors.New("no record has this ref")

// Contents is the catalogue's side of resolving: one content by ref, and
// where contents sit on disks.
type Contents interface {
	Content(ctx context.Context, ref string) (view.Content, error)
	Places(ctx context.Context, digests []content.Digest) (map[content.Digest][]view.Place, error)
}

// Resolved says what a ref names and where the same bytes are elsewhere.
type Resolved struct {
	Ref   string     `json:"ref" doc:"The form to cite: bank:<ref> for a message, a library ID, or attic:<ref> for bytes."`
	Kind  string     `json:"kind" enum:"message,retired_message,item,activity,collection,file,page,content" doc:"content is bytes, wherever the archive or a disk holds them."`
	Title string     `json:"title" doc:"Subject or opening words, a title, a filename or a path."`
	At    *time.Time `json:"at,omitempty" doc:"When the message was sent."`
	Href  string     `json:"href" doc:"The route that returns the whole record."`
	Links []Link     `json:"links" doc:"Attachments, and the same bytes in the other store."`
}

type Link struct {
	Relation string `json:"relation" enum:"attachment,on_disk,in_archive,replaced_by" doc:"attachment: a file attached to this message, by its BLAKE3 digest. on_disk: a place on a disk holding the same bytes. in_archive: a message attachment or library file holding the same bytes. replaced_by: what a retired message became."`
	Ref      string `json:"ref"`
	Title    string `json:"title"`
	Href     string `json:"href"`
}

// Resolve finds what ref names, whichever store holds it.
func Resolve(ctx context.Context, archive *store.Store, contents Contents, ref string) (Resolved, error) {
	ref = strings.TrimSpace(ref)
	bare := strings.ToLower(strings.TrimPrefix(ref, "bank:"))
	switch {
	case strings.HasPrefix(ref, "attic:"):
		return resolveContent(ctx, archive, contents, ref)
	case store.ValidRef(bare) == nil:
		return resolveMessage(ctx, archive, contents, bare)
	case strings.HasPrefix(ref, "bank:"):
		return Resolved{}, fmt.Errorf("%q is not a message ref: %w", ref, ErrNoRecord)
	}
	if kind, _, ok := strings.Cut(ref, "_"); ok {
		return resolveLibrary(ctx, archive, contents, kind, ref)
	}
	return resolveContent(ctx, archive, contents, ref)
}

func resolveMessage(ctx context.Context, archive *store.Store, contents Contents, ref string) (Resolved, error) {
	m, attachments, err := archive.GetMessageByRef(ctx, ref)
	if retired, ok := errors.AsType[*store.RetiredError](err); ok {
		out := Resolved{Ref: "bank:" + ref, Kind: "retired_message", Title: retired.Retired.Subject, At: &retired.Retired.SentAt,
			Href: "/v1/messages/" + ref, Links: []Link{}}
		if id := retired.Retired.Replacement; id != "" {
			out.Links = append(out.Links, Link{Relation: "replaced_by", Ref: id, Href: "/v1/refs/" + id})
		}
		return out, nil
	}
	if errors.Is(err, store.ErrNotFound) {
		return Resolved{}, fmt.Errorf("message %s: %w", ref, ErrNoRecord)
	}
	if err != nil {
		return Resolved{}, err
	}
	title := m.Subject
	if title == "" {
		title = firstWords(m.Body)
	}
	out := Resolved{Ref: "bank:" + ref, Kind: "message", Title: title, At: &m.SentAt, Href: "/v1/messages/" + ref, Links: []Link{}}
	digests := make([]content.Digest, len(attachments))
	for i, a := range attachments {
		digests[i] = a.BLAKE3
	}
	places, err := contents.Places(ctx, digests)
	if err != nil {
		return out, err
	}
	for _, a := range attachments {
		out.Links = append(out.Links, Link{Relation: "attachment", Ref: a.BLAKE3.String(), Title: a.Filename, Href: "/v1/blobs/" + a.BLAKE3.String()})
		out.Links = append(out.Links, onDisk(places[a.BLAKE3])...)
	}
	return out, nil
}

func resolveLibrary(ctx context.Context, archive *store.Store, contents Contents, kind, id string) (Resolved, error) {
	out := Resolved{Ref: id, Kind: kind, Links: []Link{}}
	var err error
	switch kind {
	case "item":
		v, e := archive.LibraryItem(ctx, id)
		out.Title, out.Href, err = v.Title, "/v1/library/items/"+id, e
	case "activity":
		v, e := archive.LibraryActivity(ctx, id)
		out.Title, out.Href, err = v.Title, "/v1/library/activity/"+id, e
	case "collection":
		v, e := archive.LibraryCollection(ctx, id)
		out.Title, out.Href, err = v.Title, "/v1/library/collections/"+id, e
	case "page":
		v, e := archive.LibraryPage(ctx, id)
		out.Title, out.Href, err = v.Title, "/v1/library/pages/"+id, e
	case "file":
		v, e := archive.LibraryFile(ctx, id)
		out.Title, out.Href, err = v.Filename, "/v1/library/files/"+id, e
		if e == nil {
			var places map[content.Digest][]view.Place
			places, err = contents.Places(ctx, []content.Digest{v.BLAKE3})
			out.Links = onDisk(places[v.BLAKE3])
		}
	default:
		return Resolved{}, fmt.Errorf("%q: %w", id, ErrNoRecord)
	}
	if errors.Is(err, store.ErrNotFound) {
		return Resolved{}, fmt.Errorf("%s: %w", id, ErrNoRecord)
	}
	return out, err
}

func resolveContent(ctx context.Context, archive *store.Store, contents Contents, ref string) (Resolved, error) {
	found, err := contents.Content(ctx, ref)
	if errors.Is(err, atticstore.ErrNotFound) {
		return Resolved{}, fmt.Errorf("%q: %w", ref, ErrNoRecord)
	}
	if err != nil {
		return Resolved{}, err
	}
	held, err := archive.ArchivePlaces(ctx, found.BLAKE3)
	if err != nil {
		return Resolved{}, err
	}
	out := Resolved{Ref: "attic:" + found.Ref, Kind: "content", Href: "/attic/v1/contents/" + found.Ref, Links: []Link{}}
	if len(held) > 0 {
		out.Title = held[0].Filename
	} else if len(found.Occurrences) > 0 {
		out.Title = view.BestCopy(found.Occurrences).Display
	}
	for _, p := range held {
		link := Link{Relation: "in_archive", Ref: found.BLAKE3.String(), Title: p.Filename, Href: "/v1/attachments/" + found.BLAKE3.String() + "/messages"}
		if p.LibraryFileID != "" {
			link.Ref, link.Href = p.LibraryFileID, "/v1/library/files/"+p.LibraryFileID
		}
		out.Links = append(out.Links, link)
	}
	var current []view.Place
	for _, place := range found.Occurrences {
		if place.Version != atticstore.VersionPrevious {
			current = append(current, place)
		}
	}
	out.Links = append(out.Links, onDisk(current)...)
	return out, nil
}

// onDisk links the places on disks that hold a content.
func onDisk(places []view.Place) []Link {
	links := []Link{}
	for _, place := range places {
		links = append(links, Link{Relation: "on_disk", Ref: "attic:" + place.Ref, Title: place.Display, Href: "/attic/v1/contents/" + place.Ref})
	}
	return links
}

func firstWords(body string) string {
	body = strings.Join(strings.Fields(body), " ")
	if r := []rune(body); len(r) > 100 {
		return string(r[:100]) + "…"
	}
	return body
}
