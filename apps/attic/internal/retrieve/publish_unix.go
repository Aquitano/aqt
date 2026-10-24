//go:build unix

package retrieve

import "os"

func publish(source, destination string) error {
	return os.Link(source, destination)
}
