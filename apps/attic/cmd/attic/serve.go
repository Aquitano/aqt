package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/aquitano/aqt/apps/attic/internal/api"
)

type serveCmd struct {
	Listen string `default:"127.0.0.1:8490" env:"ATTIC_LISTEN" help:"Address to listen on. There is no TLS: bind a Tailscale address to reach it from the tailnet."`
	Config string `help:"Configuration file for the content rules downloads respect."`
}

func (cmd *serveCmd) Run(ctx context.Context) error {
	cfg, _, err := loadConfig(cmd.Config)
	if err != nil {
		return err
	}
	tokens, err := api.DefaultTokens()
	if err != nil {
		return err
	}
	if names, err := tokens.Names(); err != nil {
		return err
	} else if len(names) == 0 {
		slog.Warn("no tokens yet; every /v1 request answers 401 until 'attic token new <name>'")
	}
	st, err := openReadOnlyStore(ctx)
	if err != nil {
		return err
	}
	defer st.Close()
	srv := &http.Server{Addr: cmd.Listen, Handler: api.New(st, cfg, tokens), ReadHeaderTimeout: 10 * time.Second}
	served := make(chan error, 1)
	go func() { served <- srv.ListenAndServe() }()
	slog.Info("serving the catalogue", "addr", cmd.Listen, "openapi", "http://"+cmd.Listen+"/openapi.json")
	select {
	case err := <-served:
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdown); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}

type tokenCmd struct {
	New    tokenNewCmd    `cmd:"" help:"Mint an API token; it is printed once."`
	List   tokenListCmd   `cmd:"" help:"List token names."`
	Revoke tokenRevokeCmd `cmd:"" help:"Revoke a token."`
}

type tokenNewCmd struct {
	Name string `arg:"" help:"Who the token is for, such as executor."`
}

func (cmd *tokenNewCmd) Run() error {
	tokens, err := api.DefaultTokens()
	if err != nil {
		return err
	}
	token, err := tokens.New(cmd.Name)
	if err != nil {
		return err
	}
	fmt.Println(token)
	fmt.Fprintln(os.Stderr, "attic: store it now; only its digest is kept")
	return nil
}

type tokenListCmd struct{}

func (tokenListCmd) Run() error {
	tokens, err := api.DefaultTokens()
	if err != nil {
		return err
	}
	names, err := tokens.Names()
	for _, name := range names {
		fmt.Println(name)
	}
	return err
}

type tokenRevokeCmd struct {
	Name string `arg:""`
}

func (cmd *tokenRevokeCmd) Run() error {
	tokens, err := api.DefaultTokens()
	if err != nil {
		return err
	}
	return tokens.Revoke(cmd.Name)
}

type openapiCmd struct{}

func (openapiCmd) Run() error {
	spec, err := api.Spec()
	if err != nil {
		return err
	}
	_, err = fmt.Println(string(spec))
	return err
}
