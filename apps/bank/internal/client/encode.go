package client

import (
	"bytes"
	"cmp"
	"encoding"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"

	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
)

type request struct {
	path        string
	query       url.Values
	header      http.Header
	body        io.Reader
	contentType string
}

// encode writes in the way Huma reads an operation's input: path, query and
// header parameters from their tags, embedded structs field by field, Body as
// JSON and RawBody as it is. A zero parameter is left out, so the server
// applies its default, unless the default is something else and the minimum
// allows zero: then the zero is what the caller meant, and it is sent.
func encode(op httpapi.Operation, in any) (request, error) {
	r := request{path: op.Path, query: url.Values{}, header: http.Header{}}
	err := r.fields(reflect.ValueOf(in))
	return r, err
}

func (r *request) fields(v reflect.Value) error {
	t := v.Type()
	for i := range t.NumField() {
		f, value := t.Field(i), v.Field(i)
		if !f.IsExported() {
			continue
		}
		if f.Anonymous && f.Type.Kind() == reflect.Struct {
			if err := r.fields(value); err != nil {
				return err
			}
			continue
		}
		switch f.Name {
		case "Body":
			b, err := json.Marshal(value.Interface())
			if err != nil {
				return err
			}
			r.body, r.contentType = bytes.NewReader(b), "application/json"
			continue
		case "RawBody":
			if value.Len() > 0 {
				r.body, r.contentType = bytes.NewReader(value.Bytes()), cmp.Or(f.Tag.Get("contentType"), "application/octet-stream")
			}
			continue
		}
		var set func(name, text string)
		name, ok := f.Tag.Lookup("path")
		switch {
		case ok:
			set = func(name, text string) { r.path = strings.Replace(r.path, "{"+name+"}", url.PathEscape(text), 1) }
		case f.Tag.Get("query") != "":
			name, set = strings.Split(f.Tag.Get("query"), ",")[0], r.query.Set
		case f.Tag.Get("header") != "":
			name, set = f.Tag.Get("header"), r.header.Set
		default:
			continue
		}
		text, err := param(value)
		if err != nil {
			return fmt.Errorf("%s: %w", f.Name, err)
		}
		if (value.IsZero() || (value.Kind() == reflect.Slice && value.Len() == 0)) && !meantZero(f, text) {
			continue
		}
		set(name, text)
	}
	return nil
}

func meantZero(f reflect.StructField, zero string) bool {
	def, ok := f.Tag.Lookup("default")
	if !ok || def == zero {
		return false
	}
	minimum, err := strconv.ParseFloat(f.Tag.Get("minimum"), 64)
	return err != nil || minimum <= 0
}

// param is a parameter's text, written the way Huma parses it back.
func param(v reflect.Value) (string, error) {
	switch x := v.Interface().(type) {
	case encoding.TextMarshaler:
		b, err := x.MarshalText()
		return string(b), err
	case fmt.Stringer:
		return x.String(), nil
	}
	switch v.Kind() {
	case reflect.String:
		return v.String(), nil
	case reflect.Bool:
		return strconv.FormatBool(v.Bool()), nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return strconv.FormatInt(v.Int(), 10), nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return strconv.FormatUint(v.Uint(), 10), nil
	case reflect.Slice:
		items := make([]string, v.Len())
		for i := range items {
			text, err := param(v.Index(i))
			if err != nil {
				return "", err
			}
			items[i] = text
		}
		return strings.Join(items, ","), nil
	}
	return "", fmt.Errorf("cannot write a %s as a parameter", v.Type())
}
