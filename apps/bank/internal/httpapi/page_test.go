package httpapi

import (
	"reflect"
	"strconv"
	"testing"

	"github.com/aquitano/aqt/apps/bank/internal/page"
)

func TestPageParametersArePagesBounds(t *testing.T) {
	limit, _ := reflect.TypeFor[PageSize]().FieldByName("Limit")
	offset, _ := reflect.TypeFor[Page]().FieldByName("Offset")
	for _, tc := range []struct {
		tag  string
		want int
	}{
		{limit.Tag.Get("default"), page.DefaultLimit},
		{limit.Tag.Get("maximum"), page.MaxLimit},
		{offset.Tag.Get("maximum"), page.MaxOffset},
	} {
		if tc.tag != strconv.Itoa(tc.want) {
			t.Errorf("tag %q, want %d", tc.tag, tc.want)
		}
	}
}
