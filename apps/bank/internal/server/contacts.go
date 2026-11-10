package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// decodeJSON reads a small request body, refusing unknown fields so a typo in
// a field name is an error rather than a silently ignored value.
func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errors.New("invalid JSON body: " + strings.TrimSpace(err.Error()))
	}
	return nil
}
