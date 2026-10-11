// Package archive lists what archives hold. The archive on disk is read
// through the handle the caller opens, so its last-access time survives.
// Archives nested inside are copied to a temporary folder, listed and deleted.
package archive

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"github.com/aquitano/aqt/apps/attic/internal/scratch"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

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

// Outcomes of reading an archive. A damaged archive keeps whatever members
// were read before the damage. A split part is a later volume of a
// multi-volume archive, listed with its first volume.
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
	// folder when empty. The folder must already exist.
	Temp string
	// Log receives nested archive events and stale cleanup warnings; nil logs
	// nothing.
	Log *slog.Logger
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
// List returns errors for cancellation, a failing emit, an UnreadableError,
// or failures creating, writing or cleaning up the temporary workspace.
// Cleanup can fail after all members have been emitted; its error is joined
// with any listing error. A damaged, encrypted or unknown archive is reported
// in Result.
func List(ctx context.Context, p string, open Opener, o Options, emit func(Member) error, skip func(Skip)) (res Result, err error) {
	if laterVolume.MatchString(filepath.Base(p)) {
		return Result{Format: "rar", Status: Split}, nil
	}
	if o.Depth > 1 {
		workspace, createErr := scratch.New(o.Temp, o.Log)
		if createErr != nil {
			return Result{}, createErr
		}
		defer func() { err = errors.Join(err, workspace.Close()) }()
		o.Temp = workspace.Path
	}
	l := lister{o: o, emit: emit, skip: skip, watch: &watch{ctx: ctx}, log: cmp.Or(o.Log, slog.New(slog.DiscardHandler))}
	res, err = l.list(ctx, p, open, "", 1)
	// A read that failed anywhere, a nested archive's included, says the disk
	// faltered; the listing is dropped and the next scan tries again.
	if err == nil && l.watch.err != nil {
		err = UnreadableError{l.watch.err}
	}
	return res, err
}

// laterVolume names the second and later parts of a split rar, which are
// listed with the first. RAR4 parts do not say so in a way rardecode reports.
var laterVolume = regexp.MustCompile(`(?i)\.part0*([2-9]|[1-9]\d+)\.rar$`)

type lister struct {
	o     Options
	emit  func(Member) error
	skip  func(Skip)
	watch *watch
	log   *slog.Logger
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

// watch sees every read of every file a listing opens. It keeps the first
// failed read, so a disk error never becomes an archive's status, and it
// fails reads once ctx is cancelled, which stops libraries that decode long
// stretches of a solid archive without calling back.
type watch struct {
	ctx context.Context
	err error
}

// note keeps only errors from the operating system. A short read, a bad offset
// from a corrupt header or a decompressor's complaint is the archive's doing
// and gets classified as such.
func (w *watch) note(err error) {
	if w.err == nil && errors.As(err, new(syscall.Errno)) {
		w.err = err
	}
}

type watchedFile struct {
	*os.File
	w *watch
}

func (f watchedFile) Read(p []byte) (int, error) {
	if err := f.w.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := f.File.Read(p)
	f.w.note(err)
	return n, err
}

func (f watchedFile) ReadAt(p []byte, off int64) (int, error) {
	if err := f.w.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := f.File.ReadAt(p, off)
	f.w.note(err)
	return n, err
}

func (f watchedFile) Seek(offset int64, whence int) (int64, error) {
	n, err := f.File.Seek(offset, whence)
	f.w.note(err)
	return n, err
}

func (l *lister) open(open Opener, p string) (watchedFile, error) {
	f, err := open(p)
	if err != nil {
		return watchedFile{}, err
	}
	return watchedFile{File: f, w: l.watch}, nil
}

// openMember hands out a member's bytes. Some readers allow it only while
// their walk sits on that member.
type openMember func() (io.ReadCloser, error)

func (l *lister) list(ctx context.Context, p string, open Opener, prefix string, level int) (Result, error) {
	f, err := l.open(open, p)
	if err != nil {
		return Result{}, UnreadableError{err}
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Result{}, UnreadableError{err}
	}
	ex, err := identify(ctx, f, info.Size())
	if err != nil {
		return Result{}, UnreadableError{err}
	}
	if ex == nil {
		return Result{Status: NotArchive}, nil
	}
	res := Result{Format: strings.TrimPrefix(ex.Extension(), ".")}
	if _, ok := ex.(archives.Rar); ok {
		err = l.rar(ctx, dirFS{dir: filepath.Dir(p), open: open, l: l}, filepath.Base(p), prefix, level)
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
	case ctx.Err() != nil:
		return res, ctx.Err()
	case errors.As(err, &stop):
		return res, stop.err
	case l.watch.err != nil:
		return res, UnreadableError{l.watch.err}
	case err == nil:
		res.Status = Listed
	case volumeMissing(err) && level == 1:
		// The other parts may be on another disk, or come back.
		return res, UnreadableError{err}
	case volumeMissing(err):
		res.Status, res.Detail = Split, "its other volumes are not beside it: "+err.Error()
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
	name, modified := fi.NameInArchive, fi.ModTime()
	zh, isZip := fi.Header.(zip.FileHeader)
	if isZip {
		// Without the UTF-8 flag, Windows writes names in the OEM code page,
		// 850 on Western European systems; macOS and Info-ZIP write UTF-8
		// without the flag. CP850 names are almost never valid UTF-8.
		if !utf8.ValidString(name) {
			name, _ = charmap.CodePage850.NewDecoder().String(name)
		}
		// A time from the MS-DOS fields alone is the writer's wall clock,
		// which the reader labels UTC.
		if t := zh.Modified; !t.IsZero() && t.Location() == time.UTC {
			modified = time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.Local)
		}
	}
	m, ok := newMember(prefix, name, fi.Size(), modified)
	switch {
	case fi.IsDir():
		m.Kind = "dir"
	case fi.Mode()&fs.ModeSymlink != 0:
		m.Kind = "link"
	}
	if isZip {
		m.Encrypted = zh.Flags&1 != 0
		if m.Kind == "file" {
			m.CRC32 = &zh.CRC32
		}
	}
	if sh, is7z := fi.Header.(sevenzip.FileHeader); is7z && m.Kind == "file" {
		m.CRC32 = &sh.CRC32
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
	tmp, err := os.CreateTemp(l.o.Temp, tempPrefix+"*"+path.Ext(m.Name))
	if err != nil {
		return fatal{err}
	}
	defer os.Remove(tmp.Name())
	started := time.Now()
	reason, detail, err := l.unpack(ctx, open, tmp)
	if err != nil {
		return fatal{err}
	}
	unpacked := time.Since(started)
	if reason != "" {
		l.log.Debug("nested archive not opened", "path", m.Path, "reason", reason, "detail", detail,
			"unpack_ms", unpacked.Milliseconds())
		l.skip(Skip{Path: m.Path, Reason: reason, Detail: detail})
		return nil
	}
	res, err := l.list(ctx, tmp.Name(), os.Open, m.Path+Separator, level+1)
	if err != nil {
		return fatal{err}
	}
	took := time.Since(started)
	attrs := []any{"path", m.Path, "level", level + 1, "format", res.Format, "status", res.Status, "bytes", m.Size,
		"unpack_ms", unpacked.Milliseconds(), "took_ms", took.Milliseconds()}
	// Reaching a member of a solid archive decodes everything before it.
	if took > slowNested {
		l.log.Info("slow nested archive", attrs...)
	} else {
		l.log.Debug("nested archive listed", attrs...)
	}
	if res.Status != Listed {
		l.skip(Skip{Path: m.Path, Reason: res.Status, Detail: res.Detail})
	}
	return nil
}

const slowNested = 30 * time.Second

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
	archives.Zip{},
	archives.Rar{},
	archives.Tar{},
}

var compressions = []archives.Compression{archives.Gz{}, archives.Bz2{}, archives.Xz{}, archives.Zstd{}}

// identify picks the format from the leading bytes, in a fixed order.
// archives.Identify ranges over a map and also matches by name, so a .zip
// holding 7z bytes could come back as either, and brotli, which has no magic
// number, can claim almost anything.
func identify(ctx context.Context, f io.ReaderAt, size int64) (archives.Extraction, error) {
	for _, ex := range formats {
		if ok, err := matches(ctx, ex, f, size, nil); ok || err != nil {
			return ex, err
		}
	}
	for _, c := range compressions {
		ok, err := matches(ctx, c, f, size, nil)
		if !ok || err != nil {
			continue
		}
		// A compressed file is an archive only when it holds a tar.
		if tar, _ := matches(ctx, archives.Tar{}, f, size, c); tar {
			return archives.CompressedArchive{Extraction: archives.Tar{}, Compression: c}, nil
		}
		return nil, nil
	}
	return nil, nil
}

// matches reads through a section of its own, never the file's offset: zstd
// keeps reading ahead in a goroutine after Match returns.
func matches(ctx context.Context, format archives.Format, f io.ReaderAt, size int64, inside archives.Compression) (bool, error) {
	var r io.Reader = io.NewSectionReader(f, 0, size)
	if inside != nil {
		rc, err := inside.OpenReader(r)
		if err != nil {
			return false, nil
		}
		defer rc.Close()
		r = rc
	}
	m, err := format.Match(ctx, "", r)
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
// opener, watched like the first. rardecode probes for a next volume and takes
// a missing one as the end of an archive that has no end block, so an open
// error goes back to it rather than to the watch.
type dirFS struct {
	dir  string
	open Opener
	l    *lister
}

func (d dirFS) Open(name string) (fs.File, error) {
	f, err := d.l.open(d.open, filepath.Join(d.dir, filepath.FromSlash(name)))
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

const tempPrefix = "attic-"

// volumeMissing reports a rar that needed another volume and could not open
// it.
func volumeMissing(err error) bool {
	var pe *fs.PathError
	return errors.As(err, &pe) && pe.Op == "open"
}
