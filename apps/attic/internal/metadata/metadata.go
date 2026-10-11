// Package metadata reads descriptive tags from scratch copies in one ExifTool batch.
package metadata

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
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

// Result excludes file-system tags, which describe the disposable copy.
type Result struct {
	Status string         `json:"status"`
	Detail string         `json:"detail,omitempty"`
	Tags   map[string]any `json:"tags"`
}

// Read returns one result per input path in the same order. A malformed batch,
// timeout or missing executable fails the batch, so no partial result is cached.
func Read(ctx context.Context, binary string, paths []string) ([]Result, error) {
	if len(paths) == 0 {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	args := []string{"-config", "", "-json", "-G1", "-s", "-n", "-charset", "filename=UTF8"}
	for _, tag := range []string{"ExifToolVersion", "Error", "Warning", "FileType", "MIMEType", "ImageWidth", "ImageHeight", "Duration", "PageCount", "Title", "Subject", "Description", "Creator", "Author", "Keywords", "DateTimeOriginal", "CreateDate", "ModifyDate", "Make", "Model", "GPSLatitude", "GPSLongitude", "City", "Country", "Artist", "Album", "Track", "Genre", "AudioSampleRate", "VideoFrameRate"} {
		args = append(args, "-"+tag)
	}
	args = append(args, "--")
	dir := filepath.Dir(paths[0])
	names := make([]string, len(paths))
	for i, path := range paths {
		if filepath.Dir(path) != dir {
			return nil, errors.New("metadata batch spans scratch directories")
		}
		names[i] = filepath.Base(path)
	}
	args = append(args, names...)
	data, runErr := process.Run(ctx, binary, dir, args, nil, 4<<20)
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	// ExifTool exits 1 for a bad file but still emits a result for every path.
	var exit *exec.ExitError
	if runErr != nil && (!errors.As(runErr, &exit) || exit.ExitCode() != 1) {
		return nil, runErr
	}
	var rows []map[string]any
	if err := json.Unmarshal(data, &rows); err != nil {
		return nil, fmt.Errorf("exiftool JSON: %w", errors.Join(err, runErr))
	}
	byPath := make(map[string]map[string]any, len(rows))
	for _, row := range rows {
		path, ok := row["SourceFile"].(string)
		if !ok || byPath[path] != nil {
			return nil, errors.New("exiftool returned missing or duplicate SourceFile")
		}
		delete(row, "SourceFile")
		byPath[path] = row
	}
	if len(byPath) != len(paths) {
		return nil, errors.New("exiftool returned an incomplete batch")
	}
	results := make([]Result, len(paths))
	for i, path := range names {
		tags, ok := byPath[path]
		if !ok {
			return nil, fmt.Errorf("exiftool omitted %s", path)
		}
		res := Result{Status: "ok", Tags: tags}
		for key, value := range tags {
			if strings.HasSuffix(key, ":Error") || key == "Error" {
				res.Status, res.Detail = "failed", fmt.Sprint(value)
			}
		}
		results[i] = res
	}
	return results, nil
}
