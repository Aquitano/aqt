package server

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// Run stops accepting work on cancellation and drains requests before the
// caller closes its database pools. Long-running requests get 30 seconds.
func Run(ctx context.Context, srv *http.Server) error {
	return run(ctx, srv, srv.ListenAndServe)
}

func run(ctx context.Context, srv *http.Server, listen func() error) error {
	stopped := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			drain, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			err := srv.Shutdown(drain)
			if err != nil {
				_ = srv.Close()
			}
			stopped <- err
		case <-done:
			stopped <- nil
		}
	}()
	err := listen()
	close(done)
	if errors.Is(err, http.ErrServerClosed) {
		return <-stopped
	}
	return err
}
