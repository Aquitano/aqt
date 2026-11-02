// Package metadata reads descriptive tags from files with one ExifTool that
// stays running.
package metadata

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/process"
)

var Extensions = []string{
	"jpg", "jpeg", "png", "gif", "webp", "tif", "tiff", "heic", "heif", "avif", "bmp", "dng", "cr2", "cr3", "nef", "arw", "orf", "rw2",
	"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "epub",
	"mp3", "flac", "wav", "m4a", "ogg", "opus", "aiff", "wma",
	"mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "mts", "m2ts",
}

var tags = []string{"ExifToolVersion", "Error", "Warning", "FileType", "MIMEType", "ImageWidth", "ImageHeight", "Duration", "PageCount", "Title", "Subject", "Description", "Creator", "Author", "Keywords", "DateTimeOriginal", "CreateDate", "ModifyDate", "Make", "Model", "GPSLatitude", "GPSLongitude", "City", "Country", "Artist", "Album", "Track", "Genre", "AudioSampleRate", "VideoFrameRate"}

const (
	timeout   = 2 * time.Minute
	maxOutput = 4 << 20
)

// Result excludes file-system tags; entries record those for each path.
type Result struct {
	Status string         `json:"status"`
	Detail string         `json:"detail,omitempty"`
	Tags   map[string]any `json:"tags"`
}

// Reader keeps one ExifTool running in -stay_open mode and asks it about one
// file at a time, so a caller holds each file only while ExifTool reads it.
// It is not safe for concurrent use.
type Reader struct {
	binary   string
	proc     *process.Proc
	out      *bufio.Reader
	requests int
}

func NewReader(binary string) *Reader { return &Reader{binary: binary} }

// Read returns one file's tags. A file ExifTool cannot parse comes back as a
// failed Result. An error means the tool failed, timed out or answered with
// something that cannot be trusted, and the next Read starts a fresh ExifTool.
func (r *Reader) Read(ctx context.Context, path string) (Result, error) {
	// Request lines are file names, so one must not pass for an option or
	// split into two lines.
	if !filepath.IsAbs(path) || strings.ContainsAny(path, "\r\n") {
		return Result{}, fmt.Errorf("metadata needs an absolute path on one line: %q", path)
	}
	if r.proc == nil {
		if err := r.start(); err != nil {
			return Result{}, err
		}
	}
	r.requests++
	// SourceFile comes back with forward slashes.
	name := filepath.ToSlash(path)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	type answer struct {
		data []byte
		err  error
	}
	done := make(chan answer, 1)
	go func(proc *process.Proc, out *bufio.Reader, n int) {
		data, err := exchange(proc, out, name, n)
		done <- answer{data, err}
	}(r.proc, r.out, r.requests)
	var a answer
	select {
	case a = <-done:
	case <-ctx.Done():
		r.Close()
		<-done
		return Result{}, fmt.Errorf("exiftool on %s: %w", name, ctx.Err())
	}
	if a.err != nil {
		proc := r.proc
		r.Close()
		return Result{}, fmt.Errorf("exiftool on %s: %w: %s", name, a.err, proc.Stderr())
	}
	res, err := parse(a.data, name)
	if err != nil {
		r.Close()
	}
	return res, err
}

func (r *Reader) Close() {
	if r.proc != nil {
		r.proc.Close()
		r.proc, r.out = nil, nil
	}
}

func (r *Reader) start() error {
	// ExifTool reads its command line in the ANSI code page on Windows, so file
	// names arrive through the argument stream, which it reads as UTF-8.
	args := []string{"-config", "", "-stay_open", "True", "-@", "-",
		"-common_args", "-json", "-G1", "-s", "-n", "-charset", "filename=UTF8", "-api", "WindowsLongPath=1"}
	for _, tag := range tags {
		args = append(args, "-"+tag)
	}
	proc, err := process.Start(context.Background(), r.binary, args)
	if err != nil {
		return err
	}
	r.proc, r.out = proc, bufio.NewReaderSize(proc.Stdout, 64<<10)
	return nil
}

// exchange sends one file name and reads until ExifTool reports the request
// done with {readyN}.
func exchange(proc *process.Proc, out *bufio.Reader, name string, n int) ([]byte, error) {
	if _, err := fmt.Fprintf(proc.Stdin, "%s\n-execute%d\n", name, n); err != nil {
		return nil, err
	}
	ready := fmt.Sprintf("{ready%d}", n)
	var data, line []byte
	for len(data)+len(line) <= maxOutput {
		chunk, err := out.ReadSlice('\n')
		line = append(line, chunk...)
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if string(bytes.TrimRight(line, "\r\n")) == ready {
			return data, nil
		}
		data, line = append(data, line...), line[:0]
	}
	return nil, process.ErrOutputLimit
}

func parse(data []byte, name string) (Result, error) {
	var rows []map[string]any
	if err := json.Unmarshal(data, &rows); err != nil {
		return Result{}, fmt.Errorf("exiftool JSON for %s: %w", name, err)
	}
	if len(rows) != 1 || rows[0]["SourceFile"] != name {
		return Result{}, fmt.Errorf("exiftool returned no result for %s", name)
	}
	tags := rows[0]
	delete(tags, "SourceFile")
	res := Result{Status: "ok", Tags: tags}
	for key, value := range tags {
		if strings.HasSuffix(key, ":Error") || key == "Error" {
			res.Status, res.Detail = "failed", fmt.Sprint(value)
		}
	}
	return res, nil
}
