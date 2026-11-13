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
	"github.com/aquitano/aqt/apps/bank/internal/ref"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// ErrNoRecord means a ref is well formed and names nothing.
var ErrNoRecord = errors.New("no record has this ref")

// Contents is the catalogue's side of resolving: one content by ref, and
// where contents sit on disks.
type Contents interface {
	Content(ctx context.Context, cited ref.Content) (view.Content, error)
	Places(ctx context.Context, digests []content.Digest) (map[content.Digest][]view.Place, error)
}

// Resolved says what a ref names and where the same bytes are elsewhere.
type Resolved struct {
	Ref   string     `json:"ref" doc:"The form to cite: msg:<hex> for a message, the record's ID for the library, or content:<hex> for bytes."`
	Kind  string     `json:"kind" enum:"message,retired_message,item,activity,collection,file,page,content" doc:"content is bytes, wherever the archive or a disk holds them."`
	Title string     `json:"title" doc:"Subject or opening words, a title, a filename or a path."`
	At    *time.Time `json:"at,omitempty" doc:"When the message was sent."`
	Href  string     `json:"href" doc:"The route that returns the whole record."`
	Links []Link     `json:"links" doc:"Attachments, and the same bytes in the other store."`
}

type Link struct {
	Relation string `json:"relation" enum:"attachment,on_disk,in_archive,replaced_by" doc:"attachment: a file attached to this message, by its whole BLAKE3 digest. on_disk: a place on a disk holding the same bytes. in_archive: a message attachment or library file holding the same bytes. replaced_by: what a retired message became."`
	Ref      string `json:"ref"`
	Title    string `json:"title"`
	Href     string `json:"href"`
}

// Resolve finds what a parsed ref names, whichever store holds it.
func Resolve(ctx context.Context, archive *store.Store, contents Contents, cited ref.Ref) (Resolved, error) {
	switch cited.Kind() {
	case ref.KindMessage:
		m, err := cited.Message()
		if err != nil {
			return Resolved{}, err
		}
		return resolveMessage(ctx, archive, contents, m)
	case ref.KindContent:
		c, err := cited.Content()
		if err != nil {
			return Resolved{}, err
		}
		return resolveContent(ctx, archive, contents, c)
	}
	return resolveLibrary(ctx, archive, contents, cited)
}

func resolveMessage(ctx context.Context, archive *store.Store, contents Contents, cited ref.Message) (Resolved, error) {
	m, attachments, err := archive.GetMessageByRef(ctx, cited)
	if retired, ok := errors.AsType[*store.RetiredError](err); ok {
		out := Resolved{Ref: cited.String(), Kind: "retired_message", Title: retired.Retired.Subject, At: &retired.Retired.SentAt,
			Href: "/v1/messages/" + cited.String(), Links: []Link{}}
		if id := retired.Retired.Replacement; id != "" {
			out.Links = append(out.Links, Link{Relation: "replaced_by", Ref: id, Href: "/v1/refs/" + id})
		}
		return out, nil
	}
	if errors.Is(err, store.ErrNotFound) {
		return Resolved{}, fmt.Errorf("message %s: %w", cited, ErrNoRecord)
	}
	if err != nil {
		return Resolved{}, err
	}
	title := m.Subject
	if title == "" {
		title = firstWords(m.Body)
	}
	out := Resolved{Ref: cited.String(), Kind: "message", Title: title, At: &m.SentAt, Href: "/v1/messages/" + cited.String(), Links: []Link{}}
	digests := make([]content.Digest, len(attachments))
	for i, a := range attachments {
		digests[i] = a.BLAKE3
	}
	places, err := contents.Places(ctx, digests)
	if err != nil {
		return out, err
	}
	for _, a := range attachments {
		out.Links = append(out.Links, Link{Relation: "attachment", Ref: ref.ForContent(a.BLAKE3).String(), Title: a.Filename, Href: "/v1/blobs/" + a.BLAKE3.String()})
		out.Links = append(out.Links, onDisk(places[a.BLAKE3])...)
	}
	return out, nil
}

func resolveLibrary(ctx context.Context, archive *store.Store, contents Contents, cited ref.Ref) (Resolved, error) {
	id := cited.String()
	out := Resolved{Ref: id, Kind: string(cited.Kind()), Links: []Link{}}
	var err error
	switch cited.Kind() {
	case ref.KindItem:
		v, e := archive.LibraryItem(ctx, id)
		out.Title, out.Href, err = v.Title, "/v1/library/items/"+id, e
	case ref.KindActivity:
		v, e := archive.LibraryActivity(ctx, id)
		out.Title, out.Href, err = v.Title, "/v1/library/activity/"+id, e
	case ref.KindCollection:
		v, e := archive.LibraryCollection(ctx, id)
		out.Title, out.Href, err = v.Title, "/v1/library/collections/"+id, e
	case ref.KindPage:
		v, e := archive.LibraryPage(ctx, id)
		out.Title, out.Href, err = v.Title, "/v1/library/pages/"+id, e
	case ref.KindFile:
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

func resolveContent(ctx context.Context, archive *store.Store, contents Contents, cited ref.Content) (Resolved, error) {
	found, err := contents.Content(ctx, cited)
	if errors.Is(err, atticstore.ErrNotFound) {
		return Resolved{}, fmt.Errorf("%s: %w", cited, ErrNoRecord)
	}
	if err != nil {
		return Resolved{}, err
	}
	held, err := archive.ArchivePlaces(ctx, found.BLAKE3)
	if err != nil {
		return Resolved{}, err
	}
	out := Resolved{Ref: found.Ref, Kind: "content", Href: "/attic/v1/contents/" + found.Ref, Links: []Link{}}
	if len(held) > 0 {
		out.Title = held[0].Filename
	} else if len(found.Occurrences) > 0 {
		out.Title = view.BestCopy(found.Occurrences).Display
	}
	for _, p := range held {
		link := Link{Relation: "in_archive", Ref: ref.ForContent(found.BLAKE3).String(), Title: p.Filename, Href: "/v1/attachments/" + found.BLAKE3.String() + "/messages"}
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
		links = append(links, Link{Relation: "on_disk", Ref: place.Ref, Title: place.Display, Href: "/attic/v1/contents/" + place.Ref})
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
