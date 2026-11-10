package catalog

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	atticstore "github.com/aquitano/aqt/apps/bank/internal/attic/store"
	"github.com/aquitano/aqt/apps/bank/internal/attic/view"
	"github.com/aquitano/aqt/apps/bank/internal/blob"
	"github.com/aquitano/aqt/apps/bank/internal/store"
)

// ErrNoRecord means a ref is well formed and names nothing.
var ErrNoRecord = errors.New("no record has this ref")

// Contents is the catalogue's side of resolving: one content by ref.
type Contents interface {
	Content(ctx context.Context, ref string) (view.Content, error)
}

// Resolved says what a ref names and where the same bytes are elsewhere.
type Resolved struct {
	Ref   string     `json:"ref" doc:"The form to cite: bank:<ref> for a message, a library ID, a blob's SHA-256, or attic:<ref> for a file's bytes on disks."`
	Kind  string     `json:"kind" enum:"message,retired_message,item,activity,collection,file,page,blob,content" doc:"blob is bytes the archive stores; content is bytes the catalogue saw on a disk."`
	Title string     `json:"title" doc:"Subject or opening words, a title, a filename or a path."`
	At    *time.Time `json:"at,omitempty" doc:"When the message was sent."`
	Href  string     `json:"href" doc:"The route that returns the whole record."`
	Links []Link     `json:"links" doc:"Attachments, and the same bytes in the other store."`
}

type Link struct {
	Relation string `json:"relation" enum:"attachment,on_disk,in_archive,replaced_by" doc:"attachment: a blob attached to this message. on_disk: a place on a disk holding the same bytes. in_archive: a blob in the archive holding the same bytes. replaced_by: what a retired message became."`
	Ref      string `json:"ref"`
	Title    string `json:"title"`
	Href     string `json:"href"`
}

// Resolve finds what ref names, whichever store holds it. contents may be nil.
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
	case blob.ValidDigest(bare) == nil:
		// 64 hex characters are a blob's SHA-256 or a content's whole BLAKE3.
		if found, err := resolveBlob(ctx, archive, contents, bare); !errors.Is(err, ErrNoRecord) {
			return found, err
		}
		return resolveContent(ctx, archive, contents, bare)
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
	for _, a := range attachments {
		out.Links = append(out.Links, Link{Relation: "attachment", Ref: a.SHA256, Title: a.Filename, Href: "/v1/blobs/" + a.SHA256})
		places, err := onDisk(ctx, archive, contents, a.SHA256)
		if err != nil {
			return out, err
		}
		out.Links = append(out.Links, places...)
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
			out.Links, err = onDisk(ctx, archive, contents, v.SHA256)
		}
	default:
		return Resolved{}, fmt.Errorf("%q: %w", id, ErrNoRecord)
	}
	if errors.Is(err, store.ErrNotFound) {
		return Resolved{}, fmt.Errorf("%s: %w", id, ErrNoRecord)
	}
	return out, err
}

func resolveBlob(ctx context.Context, archive *store.Store, contents Contents, sum string) (Resolved, error) {
	names, err := archive.BlobFilenames(ctx, sum)
	if err != nil {
		return Resolved{}, err
	}
	if len(names) == 0 {
		return Resolved{}, fmt.Errorf("blob %s: %w", sum, ErrNoRecord)
	}
	out := Resolved{Ref: sum, Kind: "blob", Title: names[0], Href: "/v1/blobs/" + sum}
	out.Links, err = onDisk(ctx, archive, contents, sum)
	return out, err
}

func resolveContent(ctx context.Context, archive *store.Store, contents Contents, ref string) (Resolved, error) {
	if contents == nil {
		return Resolved{}, fmt.Errorf("%q: this server has no file catalogue: %w", ref, ErrNoRecord)
	}
	content, err := contents.Content(ctx, ref)
	if errors.Is(err, atticstore.ErrNotFound) {
		return Resolved{}, fmt.Errorf("%q: %w", ref, ErrNoRecord)
	}
	if err != nil {
		return Resolved{}, err
	}
	out := Resolved{Ref: "attic:" + content.Ref, Kind: "content", Href: "/attic/v1/contents/" + content.Ref, Links: []Link{}}
	if len(content.Occurrences) > 0 {
		out.Title = view.BestCopy(content.Occurrences).Display
	}
	digest, err := hex.DecodeString(content.BLAKE3)
	if err != nil {
		return out, err
	}
	stored, err := archive.BlobsWithDigest(ctx, digest)
	if err != nil {
		return out, err
	}
	for _, b := range stored {
		link := Link{Relation: "in_archive", Ref: b.SHA256, Title: b.Filename, Href: "/v1/attachments/" + b.SHA256 + "/messages"}
		if b.LibraryFileID != "" {
			link.Ref, link.Href = b.LibraryFileID, "/v1/library/files/"+b.LibraryFileID
		}
		out.Links = append(out.Links, link)
	}
	return out, nil
}

// onDisk lists the places on disks that hold a stored blob's bytes. It is
// empty until the digest pass has read the blob, and when the catalogue
// cannot answer: the archive's record stands without it.
func onDisk(ctx context.Context, archive *store.Store, contents Contents, sum string) ([]Link, error) {
	links := []Link{}
	if contents == nil {
		return links, nil
	}
	digest, err := archive.BlobDigest(ctx, sum)
	if err != nil || digest == nil {
		return links, err
	}
	content, err := contents.Content(ctx, hex.EncodeToString(digest))
	if err != nil {
		return links, nil
	}
	for _, place := range content.Occurrences {
		if place.Version != atticstore.VersionPrevious {
			links = append(links, Link{Relation: "on_disk", Ref: "attic:" + content.Ref, Title: place.Display, Href: "/attic/v1/contents/" + content.Ref})
		}
	}
	return links, nil
}

func firstWords(body string) string {
	body = strings.Join(strings.Fields(body), " ")
	if r := []rune(body); len(r) > 100 {
		return string(r[:100]) + "…"
	}
	return body
}
