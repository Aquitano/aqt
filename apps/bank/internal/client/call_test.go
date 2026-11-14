package client

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/danielgtaylor/huma/v2/adapters/humago"

	"github.com/aquitano/aqt/apps/bank/internal/httpapi"
	"github.com/aquitano/aqt/apps/bank/internal/ref"
)

type echoInput struct {
	ID     string      `path:"id"`
	Cursor ref.Message `query:"cursor"`
	Groups []string    `query:"group"`
	Latest bool        `query:"latest"`
	Body   echoNote
}

type echoNote struct {
	Note string `json:"note"`
}

type echoed struct {
	ID     string   `json:"id"`
	Cursor string   `json:"cursor"`
	Groups []string `json:"groups"`
	Latest bool     `json:"latest"`
	Note   string   `json:"note"`
}

// Huma resets a parameter to its default when the operation also has a body,
// so a zero that differs from its default round-trips only without one.
type fuzzyInput struct {
	Fuzzy int `query:"fuzzy" default:"1" minimum:"0" maximum:"2"`
}

var (
	echo  = httpapi.Op[echoInput, echoed]{Operation: httpapi.Operation{ID: "echo", Method: http.MethodPost, Path: "/v1/echo/{id}", Tag: "test"}}
	fuzzy = httpapi.Op[fuzzyInput, int]{Operation: httpapi.Operation{ID: "fuzzy", Method: http.MethodGet, Path: "/v1/fuzzy", Tag: "test"}}
)

// What Call encodes is what the server decodes, in process and over a
// socket: path, query and body, and a zero that differs from its default.
func TestCallRoundTripsAnOperation(t *testing.T) {
	mux := http.NewServeMux()
	api := humago.New(mux, httpapi.Config("test", "", ""))
	httpapi.Register(api, echo, func(_ context.Context, in *echoInput) (*httpapi.Body[echoed], error) {
		return &httpapi.Body[echoed]{Body: echoed{ID: in.ID, Cursor: in.Cursor.String(), Groups: in.Groups, Latest: in.Latest, Note: in.Body.Note}}, nil
	})
	httpapi.Register(api, fuzzy, func(_ context.Context, in *fuzzyInput) (*httpapi.Body[int], error) {
		return &httpapi.Body[int]{Body: in.Fuzzy}, nil
	})
	socket := httptest.NewServer(mux)
	defer socket.Close()

	cursor, err := ref.ParseMessage("msg:0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	in := echoInput{ID: "a b/c", Cursor: cursor, Groups: []string{"message", "file"}, Latest: true, Body: echoNote{Note: "ünïcode & <tags>"}}
	want := echoed{ID: in.ID, Cursor: cursor.String(), Groups: in.Groups, Latest: true, Note: in.Body.Note}
	for name, c := range map[string]*Client{"in process": InProcess(mux), "socket": New(socket.URL, "")} {
		got, err := Call(t.Context(), c, echo, in)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %+v, %v; want %+v", name, got, err, want)
		}
		if got, err := Call(t.Context(), c, fuzzy, fuzzyInput{Fuzzy: 0}); err != nil || got != 0 {
			t.Errorf("%s: fuzzy 0 arrived as %d, %v", name, got, err)
		}
	}
}
