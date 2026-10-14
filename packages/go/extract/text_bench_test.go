package extract

import (
	"strings"
	"testing"
)

func BenchmarkNormalize(b *testing.B) {
	input := strings.Repeat("a", 5<<20)
	b.ReportAllocs()
	for b.Loop() {
		if text, cut := normalize(input, 1<<20); len(text) != 1<<20 || !cut {
			b.Fatal("incorrect normalized text")
		}
	}
}
