package client

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"

	"github.com/aquitano/aqt/apps/bank/internal/mediaimport"
)

func (c *Client) ImportMediaFile(ctx context.Context, kind, source, account, path string) (mediaimport.Result, error) {
	var result mediaimport.Result
	if kind != "netflix" && kind != "youtube-media" && kind != "library" {
		return result, fmt.Errorf("unsupported media import %q", kind)
	}
	f, err := os.Open(path)
	if err != nil {
		return result, err
	}
	defer f.Close()
	reader, writer := io.Pipe()
	defer reader.Close()
	multipartWriter := multipart.NewWriter(writer)
	go func() {
		part, err := multipartWriter.CreateFormFile("file", filepath.Base(path))
		if err == nil {
			_, err = io.Copy(part, f)
		}
		if err == nil {
			err = multipartWriter.Close()
		}
		_ = writer.CloseWithError(err)
	}()
	query := url.Values{"source": {source}, "account": {account}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/v1/import/"+kind+"?"+query.Encode(), reader)
	if err != nil {
		return result, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", multipartWriter.FormDataContentType())
	resp, err := c.hc.Do(req)
	if err != nil {
		return result, err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return result, fmt.Errorf("import %s: %s", kind, errorMessage(resp))
	}
	err = json.NewDecoder(resp.Body).Decode(&result)
	return result, err
}
