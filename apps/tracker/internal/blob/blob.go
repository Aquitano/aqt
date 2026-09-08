// Package blob hashes and compresses raw HTML for raw_html_blobs.
package blob

import (
	"github.com/klauspost/compress/zstd"
	"lukechampine.com/blake3"
)

const CodecZstd = 1

var (
	encoder *zstd.Encoder
	decoder *zstd.Decoder
)

func init() {
	var err error
	if encoder, err = zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.EncoderLevelFromZstd(3))); err != nil {
		panic(err)
	}
	if decoder, err = zstd.NewReader(nil, zstd.WithDecoderConcurrency(0), zstd.WithDecoderMaxMemory(256<<20)); err != nil {
		panic(err)
	}
}

func Hash(html []byte) [32]byte { return blake3.Sum256(html) }

func Compress(html []byte) []byte {
	return encoder.EncodeAll(html, make([]byte, 0, len(html)/4))
}

func Decompress(payload []byte) ([]byte, error) {
	return decoder.DecodeAll(payload, nil)
}
