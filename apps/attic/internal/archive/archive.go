// Package archive lists what archives hold. The archive on disk is read
// through the handle the caller opens, so its last-access time survives.
// Archives nested inside are copied to a temporary folder, listed and deleted.
package archive

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/bodgit/sevenzip"
	"github.com/klauspost/compress/zip"
	"github.com/mholt/archives"
	"github.com/nwaples/rardecode/v2"
	"golang.org/x/text/encoding/charmap"
)

// Extensions mark the files worth opening; the bytes then decide the format.
// Office documents, jars and apks are zips too, but nobody searches for their
// parts.
var Extensions = []string{"zip", "7z", "rar", "tar", "tgz", "tbz2", "txz"}

// Compressed extensions mark an archive only after .tar, as in x.tar.gz. A
// server's logs/2016-07-30-1.log.gz is one compressed file.
var Compressed = []string{"gz", "bz2", "xz", "zst"}

// Outcomes of reading an archive. A damaged archive keeps the members read
// before the damage. A split part is a later volume of a multi-volume archive,
// listed with its first volume.
const (
	Listed     = "listed"
	Damaged    = "damaged"
	Encrypted  = "encrypted"
	NotArchive = "not_archive"
	Split      = "split"
)

// Separator joins the path of a nested archive and a path inside it.
const Separator = " :: "

// Member is one entry inside an archive. Path is '/'-separated and steps into
// nested archives with Separator. Times are UTC; zero means unknown.
type Member struct {
	Path      string
	Name      string
	Kind      string // file | dir | link
	Size      int64
	Modified  time.Time
	CRC32     *uint32
	Encrypted bool
}

// Skip is a nested archive that was not opened, and why.
type Skip struct {
	Path   string
	Reason string // too_deep | too_big | encrypted | damaged | not_archive | split
	Detail string
}

type Options struct {
	// Depth counts the archive levels opened, the one on disk included: 2
	// lists archives inside archives, but not a third level.
	Depth int
	// UnpackMaxBytes caps a nested archive copied out to be listed; 0 copies
	// any size.
	UnpackMaxBytes int64
	// Temp holds nested archives while they are listed, the system's temporary
	// folder when empty.
	Temp string
}

type Result struct {
	Format string
	Status string
	Detail string
}

// Opener opens the archive on disk. The scanner passes one that keeps the
// last-access time.
type Opener func(string) (*os.File, error)

// IsArchive reports whether a file name looks like an archive.
func IsArchive(name string) bool {
	name = strings.ToLower(name)
	ext := strings.TrimPrefix(path.Ext(name), ".")
	return slices.Contains(Extensions, ext) ||
		slices.Contains(Compressed, ext) && path.Ext(strings.TrimSuffix(name, "."+ext)) == ".tar"
}

// List reads the archive at p and hands every member to emit, nested
// archives' members included, as they are read rather than collected first.
//
// The error is for what makes the listing worthless rather than the archive
// bad: cancellation, a failing emit, a temporary folder that cannot be
// written, or an UnreadableError. A damaged, encrypted or unknown archive is
// a Result.
func List(ctx context.Context, p string, open Opener, o Options, emit func(Member) error, skip func(Skip)) (Result, error) {
	l := lister{o: o, emit: emit, skip: skip}
	return l.list(ctx, p, open, "", 1)
}

type lister struct {
	o    Options
	emit func(Member) error
	skip func(Skip)
}

// UnreadableError is an archive that could not be opened or read at all, which
// says nothing about its bytes; another try may succeed.
type UnreadableError struct{ Err error }

func (u UnreadableError) Error() string { return u.Err.Error() }
func (u UnreadableError) Unwrap() error { return u.Err }

// fatal carries an error that must stop the listing through the archive
// libraries, which wrap whatever a handler returns.
type fatal struct{ err error }

func (f fatal) Error() string { return f.err.Error() }
func (f fatal) Unwrap() error { return f.err }

// openMember hands out a member's bytes. Some readers allow it only while
// their walk sits on that member.
type openMember func() (io.ReadCloser, error)

func (l *lister) list(ctx context.Context, p string, open Opener, prefix string, level int) (Result, error) {
	f, err := open(p)
	if err != nil {
		return Result{}, UnreadableError{err}
	}
	defer f.Close()
	ex, err := identify(ctx, f)
	if err != nil {
		return Result{}, UnreadableError{err}
	}
	if ex == nil {
		return Result{Status: NotArchive}, nil
	}
	res := Result{Format: strings.TrimPrefix(ex.Extension(), ".")}
	if _, ok := ex.(archives.Rar); ok {
		err = l.rar(ctx, dirFS{dir: filepath.Dir(p), open: open}, filepath.Base(p), prefix, level)
	} else {
		err = ex.Extract(ctx, f, func(ctx context.Context, fi archives.FileInfo) error {
			m, ok := memberOf(fi, prefix)
			if !ok {
				return nil
			}
			if err := l.emit(m); err != nil {
				return fatal{err}
			}
			if !l.opens(m, level) {
				return nil
			}
			return l.nested(ctx, m, level, func() (io.ReadCloser, error) { return fi.Open() })
		})
	}
	var stop fatal
	switch {
	case err == nil:
		res.Status = Listed
	case ctx.Err() != nil:
		return res, ctx.Err()
	case errors.As(err, &stop):
		return res, stop.err
	default:
		res.Status, res.Detail = classify(err), err.Error()
	}
	return res, nil
}

// rar lists from the headers alone: rardecode.List seeks past the packed
// data, where its streaming reader would decode a solid archive whole just to
// step from one name to the next. Through the file system it also follows a
// split archive into its next volumes.
func (l *lister) rar(ctx context.Context, fsys fs.FS, name, prefix string, level int) error {
	files, err := rardecode.List(name, rardecode.FileSystem(fsys))
	if err != nil {
		return err
	}
	solid := map[string]Member{}
	for _, f := range files {
		if err := ctx.Err(); err != nil {
			return err
		}
		m, ok := newMember(prefix, f.Name, f.UnPackedSize, f.ModificationTime)
		if !ok {
			continue
		}
		switch {
		case f.IsDir:
			m.Kind = "dir"
		case f.LinkType != 0:
			m.Kind = "link"
		}
		m.Encrypted = f.Encrypted
		if err := l.emit(m); err != nil {
			return fatal{err}
		}
		switch {
		case !l.opens(m, level):
		case f.Solid:
			solid[f.Name] = m
		default:
			if err := l.nested(ctx, m, level, f.Open); err != nil {
				return err
			}
		}
	}
	if len(solid) == 0 {
		return nil
	}
	return l.rarSolid(ctx, fsys, name, solid, level)
}

// rarSolid decodes a solid archive up to the last nested archive in it: each
// file's bytes depend on every file before it.
func (l *lister) rarSolid(ctx context.Context, fsys fs.FS, name string, want map[string]Member, level int) error {
	r, err := rardecode.OpenReader(name, rardecode.FileSystem(fsys))
	if err != nil {
		return err
	}
	defer r.Close()
	for len(want) > 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		h, err := r.Next()
		if err != nil {
			for _, m := range want {
				l.skip(Skip{Path: m.Path, Reason: classify(err), Detail: err.Error()})
			}
			return nil
		}
		m, ok := want[h.Name]
		if !ok {
			continue
		}
		delete(want, h.Name)
		if err := l.nested(ctx, m, level, func() (io.ReadCloser, error) { return io.NopCloser(r), nil }); err != nil {
			return err
		}
	}
	return nil
}

func newMember(prefix, name string, size int64, modified time.Time) (Member, bool) {
	name = cleanName(name)
	if name == "" {
		return Member{}, false
	}
	m := Member{Path: prefix + name, Name: path.Base(name), Kind: "file", Size: size}
	if !modified.IsZero() {
		m.Modified = modified.UTC()
	}
	return m, true
}

func memberOf(fi archives.FileInfo, prefix string) (Member, bool) {
	m, ok := newMember(prefix, fi.NameInArchive, fi.Size(), fi.ModTime())
	switch {
	case fi.IsDir():
		m.Kind = "dir"
	case fi.Mode()&fs.ModeSymlink != 0:
		m.Kind = "link"
	}
	switch h := fi.Header.(type) {
	case zip.FileHeader:
		m.Encrypted = h.Flags&1 != 0
		if m.Kind == "file" {
			m.CRC32 = &h.CRC32
		}
	case sevenzip.FileHeader:
		if m.Kind == "file" {
			m.CRC32 = &h.CRC32
		}
	}
	return m, ok
}

// opens decides whether a member is a nested archive to list, and records why
// not when it is one that stays closed.
func (l *lister) opens(m Member, level int) bool {
	if m.Kind != "file" || !IsArchive(m.Name) {
		return false
	}
	var reason, detail string
	switch {
	case level >= l.o.Depth:
		reason, detail = "too_deep", fmt.Sprintf("archive level %d; depth is %d", level+1, l.o.Depth)
	case l.o.UnpackMaxBytes > 0 && m.Size > l.o.UnpackMaxBytes:
		reason, detail = "too_big", fmt.Sprintf("%d bytes; unpack_max_bytes is %d", m.Size, l.o.UnpackMaxBytes)
	case m.Encrypted:
		reason = Encrypted
	default:
		return true
	}
	l.skip(Skip{Path: m.Path, Reason: reason, Detail: detail})
	return false
}

// nested copies an archive inside an archive to the temporary folder, lists
// it below the member's path and deletes the copy.
func (l *lister) nested(ctx context.Context, m Member, level int, open openMember) error {
	tmp, err := os.CreateTemp(l.o.Temp, "attic-*"+path.Ext(m.Name))
	if err != nil {
		return fatal{err}
	}
	defer os.Remove(tmp.Name())
	reason, detail, err := l.unpack(ctx, open, tmp)
	if err != nil {
		return fatal{err}
	}
	if reason != "" {
		l.skip(Skip{Path: m.Path, Reason: reason, Detail: detail})
		return nil
	}
	res, err := l.list(ctx, tmp.Name(), os.Open, m.Path+Separator, level+1)
	if err != nil {
		return fatal{err}
	}
	if res.Status != Listed {
		l.skip(Skip{Path: m.Path, Reason: res.Status, Detail: res.Detail})
	}
	return nil
}

// unpack copies a member into dst and closes it. A member that cannot be
// read is a reason to skip it; a temporary file that cannot be written is an
// error.
func (l *lister) unpack(ctx context.Context, open openMember, dst *os.File) (string, string, error) {
	w := &writeErr{w: dst}
	reason, detail := l.copyOut(ctx, open, w)
	if err := errors.Join(ctx.Err(), w.err, dst.Close()); err != nil {
		return "", "", err
	}
	return reason, detail, nil
}

func (l *lister) copyOut(ctx context.Context, open openMember, w io.Writer) (string, string) {
	src, err := open()
	if err != nil {
		return classify(err), err.Error()
	}
	defer src.Close()
	var r io.Reader = ctxReader{ctx, src}
	if l.o.UnpackMaxBytes > 0 {
		r = io.LimitReader(r, l.o.UnpackMaxBytes+1)
	}
	n, err := io.Copy(w, r)
	switch {
	case err != nil:
		return classify(err), err.Error()
	case l.o.UnpackMaxBytes > 0 && n > l.o.UnpackMaxBytes:
		return "too_big", fmt.Sprintf("unpacks to more than unpack_max_bytes (%d)", l.o.UnpackMaxBytes)
	}
	return "", ""
}

func classify(err error) string {
	var se *sevenzip.ReadError
	switch {
	case errors.Is(err, rardecode.ErrArchiveEncrypted), errors.Is(err, rardecode.ErrArchivedFileEncrypted),
		errors.As(err, &se) && se.Encrypted:
		return Encrypted
	case errors.Is(err, rardecode.ErrBadVolumeNumber):
		return Split
	}
	return Damaged
}

var formats = []archives.Extraction{
	archives.SevenZip{},
	// Without the UTF-8 flag, Windows writes zip names in the OEM code page,
	// 850 on Western European systems.
	archives.Zip{TextEncoding: charmap.CodePage850},
	archives.Rar{},
	archives.Tar{},
}

var compressions = []archives.Compression{archives.Gz{}, archives.Bz2{}, archives.Xz{}, archives.Zstd{}}

// identify picks the format from the leading bytes, in a fixed order.
// archives.Identify ranges over a map and also matches by name, so a .zip
// holding 7z bytes could come back as either, and brotli, which has no magic
// number, can claim almost anything.
func identify(ctx context.Context, f io.ReadSeeker) (archives.Extraction, error) {
	for _, ex := range formats {
		if ok, err := matches(ctx, ex, f, nil); ok || err != nil {
			return ex, err
		}
	}
	for _, c := range compressions {
		ok, err := matches(ctx, c, f, nil)
		if !ok || err != nil {
			continue
		}
		// A compressed file is an archive only when it holds a tar.
		if tar, _ := matches(ctx, archives.Tar{}, f, c); tar {
			return archives.CompressedArchive{Extraction: archives.Tar{}, Compression: c}, nil
		}
		return nil, nil
	}
	_, err := f.Seek(0, io.SeekStart)
	return nil, err
}

func matches(ctx context.Context, format archives.Format, f io.ReadSeeker, inside archives.Compression) (bool, error) {
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return false, err
	}
	var r io.Reader = f
	if inside != nil {
		rc, err := inside.OpenReader(f)
		if err != nil {
			return false, nil
		}
		defer rc.Close()
		r = rc
	}
	m, err := format.Match(ctx, "", r)
	if _, serr := f.Seek(0, io.SeekStart); err == nil {
		err = serr
	}
	return m.ByStream, err
}

// cleanName turns a member's name into a relative '/'-separated path. Zips
// written on Windows sometimes use backslashes, tars often start with "./".
func cleanName(name string) string {
	name = strings.ReplaceAll(name, `\`, "/")
	name = strings.TrimLeft(strings.TrimPrefix(name, "./"), "/")
	return strings.TrimSuffix(name, "/")
}

// dirFS lets rardecode open the volumes of a split archive with the caller's
// opener.
type dirFS struct {
	dir  string
	open Opener
}

func (d dirFS) Open(name string) (fs.File, error) {
	f, err := d.open(filepath.Join(d.dir, filepath.FromSlash(name)))
	if err != nil {
		return nil, err
	}
	return f, nil
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// writeErr remembers a failed write, which io.Copy reports the same way as a
// failed read.
type writeErr struct {
	w   io.Writer
	err error
}

func (w *writeErr) Write(p []byte) (int, error) {
	n, err := w.w.Write(p)
	if err != nil && w.err == nil {
		w.err = err
	}
	return n, err
}
