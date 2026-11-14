package server

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// Drain is how long requests in flight, and running jobs, get to finish
// after a stop.
const Drain = 30 * time.Second

// Run stops accepting work on cancellation and drains requests before the
// caller closes its database pools. Long-running requests get Drain.
func Run(ctx context.Context, srv *http.Server) error {
	return run(ctx, srv, srv.ListenAndServe)
}

func run(ctx context.Context, srv *http.Server, listen func() error) error {
	stopped := make(chan error, 1)
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			drain, cancel := context.WithTimeout(context.Background(), Drain)
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
