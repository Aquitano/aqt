# Client skill

`tracker/SKILL.md` is a Claude Code skill that teaches agents that the owner's browsing memory exists and how to query it: what he read, whether he has seen a page, and where his time went. Install it wherever you run agents:

```sh
cp -r skill/tracker ~/.claude/skills/tracker
```

The skill assumes a `tracker` binary on `PATH`. `mise run tracker:service` installs it to `~/.local/bin`, so that directory has to be on the `PATH` agents get.

On the machine running `tracker serve` with authentication off, the default, nothing else is needed. Otherwise put what applies in the shell profile (`~/.zshrc`), since a skill cannot export it itself:

```sh
export TRACKER_SERVER_URL=http://mac.tailnet.ts.net:8490   # the server is not on 127.0.0.1:8490
export TRACKER_OIDC_ISSUER=https://auth.example/application/o/tracker/   # authentication is on
export TRACKER_OIDC_CLIENT_ID=tracker
export TRACKER_TOKEN_PATH=...                              # the session file is not in the default place
```

With authentication on, run `tracker login` once; the session refreshes itself after that. `tracker blob` reads the database rather than the server, so it only works where Postgres is reachable.

Verify with `tracker stats`; the skill's own preflight uses the same command and knows how to read each failure.
