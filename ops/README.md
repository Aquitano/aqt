# ops

Deploy configuration for the services that run on the VPS, and the secrets they read.

Set `AQT_VPS_HOST` (ssh alias or `user@host`) and `AQT_VPS_ROOT` (checkout path on the box, default `/opt/aqt`).

```sh
ops/deploy.sh bank
ops/deploy.sh health
ops/deploy.sh gallery/apps/server
```

`deploy.sh` pulls the checkout on the VPS, requires `apps/<app>/.env` to exist there, and runs `docker compose up -d --build --wait` in the app's directory. Compose files live next to each app's Dockerfile, not here; for the gallery that is the server sub-app, whose `.env` is the one `secrets.sh send gallery` writes. Bank's data volume is LUKS and unlocked by hand, so it never auto-restarts.

## secrets

`secrets.sh` moves one target's `.env` between the machine it runs on and Infisical's EU region. Each app is its own project, so run `infisical init` once inside the app directory and commit the `.infisical.json` it writes. What init produces is enough — the EU region is the default here, since the CLI's own default is US cloud and init writes no domain at all:

```json
{ "workspaceId": "...", "defaultEnvironment": "", "gitBranchToEnvironmentMapping": null }
```

Give the file a `"domain"` key only to send one app somewhere else, such as a self-hosted instance; a domain in the file wins over the default. Adding `"domain": "https://eu.infisical.com"` by hand is still worth it if you run bare `infisical` commands in that directory, since those know nothing about this script and will otherwise reach for US cloud.

The project comes from that file, so nothing has to be set in the environment. An app with more than one `.env` keeps the extras in a folder inside its own project rather than a project of its own: `health-frontend` is `/frontend` in health, `gallery-web` is `/web` in gallery. A folder is not created on demand and a push into a missing one fails, so make it once per environment first:

```sh
cd apps/gallery && infisical secrets folders create -n web --env dev
```

```sh
ops/secrets.sh pull gallery              # write apps/gallery/apps/server/.env from dev
ops/secrets.sh diff gallery              # what drifted; exits non-zero if anything did
ops/secrets.sh push gallery              # upload the local file, after confirming
ops/secrets.sh send health prod          # prod straight to the VPS, then ops/deploy.sh health
```

Targets are `bank`, `health`, `health-frontend`, `gallery`, `gallery-web`, `img` and `tracker`; each one names the `.env` path it owns. `pull`, `diff` and `push` all work on the checkout they run in, so they default to `dev` — the environment you actually develop against.

The VPS holds no Infisical credentials. `send` fetches an environment here and writes it over ssh to `$AQT_VPS_HOST:$AQT_VPS_ROOT`, never touching the local file, so pushing prod at the box does not disturb the dev `.env` in the checkout. It lands through a temporary name under `umask 077`, so an interrupted transfer cannot leave the box with half a file. `deploy.sh` is deliberately separate: it keeps using whatever `.env` is already there, and an Infisical outage can never block a deploy.

`pull` replaces the file and reports whether the values actually changed, comparing them the way `diff` does, so reordering and comments do not count as drift. An environment that exists but holds no secrets aborts the pull rather than emptying a working `.env`. Comments do not survive a pull; they belong in `.env.example`.

`.env.example` stays the canonical list of keys an app needs, since it is the only one of the two that can explain them. `pull`, `diff` and `send` all warn when it documents a key the environment does not have — a key it leaves empty is one the app runs without, so those are not required.

`push` hands the file to the CLI with `--file` and lets it parse the dotenv, so values never appear in command arguments — `/proc/<pid>/cmdline` is world-readable on the VPS. It upserts and never deletes: a key removed locally stays in Infisical, shows up as a removal line in `diff`, and has to be deleted in the web UI. That is the only way this script can lose you a secret, and it cannot. Verify the first push of any file with `diff`: what gets stored is whatever the CLI's parser read, which this script does not control.

Infisical stores no empty value, so `KEY=` is treated as absence everywhere: `push` names those keys and leaves them out, and `diff` does not report them as drift. Keep them in `.env.example`, where the comment explaining what empty means can live with them. The one thing to watch is a key where empty and unset differ — `TRACKER_TOKEN_PATH` is the example, empty meaning no token at all while unset means the default location — because a pulled file will have it unset.

A value spanning several lines, such as a PEM key, cannot be compared line by line. `push` and `diff` name those keys and carry on; `diff` will always report them as drifted.

`diff` exits non-zero on drift, and also when the fetch itself fails — a failure prints the CLI's error and no diff at all, so the two are not confusable.
