package ai

import (
	"context"
	"fmt"
	"math"
	"path/filepath"
	"slices"

	"github.com/aquitano/aqt/packages/go/extract"
)

type ocr struct {
	key     Key
	options extract.Options
}

func (p *ocr) Key() Key { return p.key }
func (p *ocr) Extensions() []string {
	return slices.Concat(Images, []string{"tif", "tiff", "bmp", "pdf"})
}
func (p *ocr) Read(ctx context.Context, path string) (Result, error) {
	options := p.options
	options.TempDir = filepath.Dir(path)
	if options.MaxBytes == 0 {
		options.MaxBytes = math.MaxInt64
	}
	result := extract.File(ctx, path, filepath.Base(path), "", options)
	if ctx.Err() != nil {
		return Result{}, ctx.Err()
	}
	if result.Err != nil {
		return Result{}, result.Err
	}
	if result.Status != extract.StatusOK && result.Status != extract.StatusEmpty {
		return Result{}, fmt.Errorf("OCR returned %s", result.Status)
	}
	return normalized(Result{Text: result.Text, Truncated: result.Truncated, ReportedModel: p.key.Model}), nil
}
