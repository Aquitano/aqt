package scan

import (
	"context"
	"errors"
	"slices"
	"testing"
)

func TestPageIterationAdvancesAndStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	var cursors, visited []int
	completed := 0
	err := eachPage(ctx, func(_ context.Context, after int) ([]int, error) {
		cursors = append(cursors, after)
		return []int{after + 1, after + 2}, nil
	}, func(_ context.Context, item int) error {
		visited = append(visited, item)
		if item == 3 {
			cancel()
		}
		return nil
	}, func(context.Context) error {
		completed++
		return nil
	})
	if !errors.Is(err, context.Canceled) || !slices.Equal(cursors, []int{0, 2}) || !slices.Equal(visited, []int{1, 2, 3}) || completed != 3 {
		t.Fatalf("iteration: cursors %v, visited %v, completed %d, %v", cursors, visited, completed, err)
	}
}
