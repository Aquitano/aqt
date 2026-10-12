# Deploy on a VPS

Use a Linux host with Docker Engine, Docker Compose v2 or newer, Git, OpenSSL, and GitHub CLI. On Ubuntu, follow the [Docker installation guide](https://docs.docker.com/engine/install/ubuntu/) and [GitHub CLI installation guide](https://github.com/cli/cli/blob/trunk/docs/install_linux.md). The commands below assume your user can run Docker. Use `sudo docker` instead if required by your Docker installation.

GitHub builds the server image after verification. The VPS pulls that image. Postgres uses the pinned ParadeDB image. The database has no published port, and the server binds to localhost.

The project is [Aquitano/aqt-turnstash](https://github.com/Aquitano/aqt-turnstash), and its CLI is `turnstash`. The repository is private. Authenticate with an account that has access and clone it on the VPS:

```sh
gh auth login
gh repo clone Aquitano/aqt-turnstash
cd aqt-turnstash
```

Run the remaining server commands from this directory. The VPS needs Docker but does not need Bun installed on the host. Use the published image with the commands below.

Published server images are available after a successful push workflow. Set `SERVER_IMAGE=ghcr.io/aquitano/aqt-turnstash-server@sha256:<digest>` in `deploy/.env` to pin the image you verified. Private GHCR images require a separate `docker login ghcr.io` with a classic personal access token that has `read:packages` and access to the package. GitHub CLI login does not log Docker in. See [GitHub's container registry authentication guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry). The published image targets Linux AMD64; use the source build on ARM64.

The GitHub workflow runs tests, installs the packaged agent in isolation, and checks the running containers before publishing `ghcr.io/aquitano/aqt-turnstash-server`. A pushed version tag must match `apps/agent/package.json`, such as `v0.1.0`. After those checks pass, it creates a GitHub release with `turnstash.js`, `turnstash.tgz`, and `SHA256SUMS`. It does not publish to an npm registry. Build the agent from the checkout if no release exists.

## Configure credentials

For a new deployment, generate `deploy/.env` once:

```sh
(
  umask 077
  set -C
  printf 'POSTGRES_PASSWORD=%s\nADMIN_TOKEN=%s\nSERVER_PORT=4320\n' \
    "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" > deploy/.env
)
```

This command refuses to overwrite an existing file. For an existing deployment, retain its database password and admin token. Move or copy its `.env` to `deploy/.env`, then set its permissions to `0600`. Changing `POSTGRES_PASSWORD` in this file does not change the password of an existing database.

[.env.example](.env.example) lists the settings. Use a hexadecimal database password, as generated above, because the server embeds it in a connection URL. `SERVER_PORT` changes the host port; the container still listens on 4320. Keep the credentials out of Git and store a secure copy separately.

Define this shell function for the remaining commands:

```sh
turnstash_compose() {
  docker compose -p turnstash --env-file deploy/.env \
    -f deploy/docker-compose.yml "$@"
}
```

New deployments use the project name `turnstash` and the `turnstash_db-data` volume. To upgrade an existing Codeburn deployment, keep its original project name in `-p`, usually `codeburn`, and set `POSTGRES_USER=codeburn` and `POSTGRES_DB=codeburn` in `deploy/.env`. Retain its password and admin token. This reuses the existing volume and database. Changing the project name selects a different volume.

## Start and check health

```sh
turnstash_compose config --quiet
turnstash_compose pull server
turnstash_compose up -d --wait --wait-timeout 300
turnstash_compose ps
curl --fail http://127.0.0.1:4320/api/health
```

Adjust the curl port if you changed `SERVER_PORT`. Both containers should report healthy. The server healthcheck queries the database. Inspect a failed startup with `turnstash_compose logs --tail 100 server db`.

Migrations run automatically before the server starts. Startup can take longer on a large existing archive. A healthcheck reports readiness; Docker's restart policy restarts exited containers but does not restart a running unhealthy container. See the [Compose service reference](https://docs.docker.com/reference/compose-file/services/).

### Build from source instead

For an unpublished change or an ARM64 VPS, redefine `turnstash_compose` to add `-f deploy/docker-compose.build.yml` after the base Compose file. Use `turnstash_compose build server` instead of `turnstash_compose pull server`. The other commands stay the same. Remove any pin from `SERVER_IMAGE` first, because Compose tags the built image with that name: a digest cannot be a tag, and a version tag would label the local build as the published image. The Git checkout then selects the server, so to upgrade, roll back or restore, check out the revision and build it instead of setting `SERVER_IMAGE`.

## Configure HTTPS

Point your domain's DNS records at the VPS. Allow inbound ports 80 and 443 for the host reverse proxy. Keep port 4320 private.

For Caddy running directly on the host, use [Caddyfile.example](Caddyfile.example) as a site block in your existing Caddy configuration. Replace `turnstash.example.com` with your domain and adjust the upstream port if needed. Validate the configuration before reloading the host's Caddy service. Caddy obtains and renews certificates when the domain and ports are reachable. See [Caddy's automatic HTTPS requirements](https://caddyserver.com/docs/automatic-https).

If you need Caddy, follow its [installation guide](https://caddyserver.com/docs/install). Add this site block to `/etc/caddy/Caddyfile`, using your real domain. Keep any existing site blocks:

```caddyfile
turnstash.example.com {
  reverse_proxy 127.0.0.1:4320
}
```

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl --fail https://turnstash.example.com/api/health
```

To read the dashboard admin token from your private environment file, run `sed -n 's/^ADMIN_TOKEN=//p' deploy/.env` on the VPS. Store it in your password manager.

Then check `https://your-domain/api/health`, open the dashboard, and sign in with `ADMIN_TOKEN`. Enroll an agent using the [agent setup](../README.md#agent), run one sync, and confirm its conversations appear in the dashboard before installing its schedule.

## Use authentik for dashboard login

Create an OAuth2/OpenID Connect provider in authentik and assign it to a `turnstash` application:

- Use a confidential client, the authorization code grant, and a signing key.
- Set the redirect URI to `https://turnstash.example.com/auth/callback` with strict matching.
- Add the `openid` and `profile` scope mappings and include claims in the ID token.
- Set the subject mode to the user's UUID. Restrict the application's policy bindings to your account.

Set these values in `deploy/.env`, using your public hostname and authentik user's UUID:

```dotenv
OIDC_ISSUER=https://auth.example.com/application/o/turnstash/
OIDC_CLIENT_ID=<client-id>
OIDC_CLIENT_SECRET=<client-secret>
OIDC_ADMIN_SUBJECT=<your-authentik-user-uuid>
APP_ORIGIN=https://turnstash.example.com
```

`APP_ORIGIN` must have no trailing slash. Keep `deploy/.env` private. Recreate the server with `turnstash_compose up -d --wait --wait-timeout 300`, open the dashboard, and select **Sign in with authentik**. The application checks the signed ID token and accepts only the configured subject. See authentik's [OAuth2 provider documentation](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/).

Setting `OIDC_ISSUER` disables the admin bearer token. Missing OIDC settings fail startup. Keep the reverse proxy pointed directly at Turnstash. Do not put an interactive authentik proxy in front of the agent API.

Dashboard sessions use secure HTTP-only cookies, expire after eight hours, and require the configured origin for write requests. **Sign out** revokes the current Turnstash session. It does not sign you out of authentik. Disabling an authentik account prevents new logins but does not revoke an existing Turnstash session immediately. To revoke all dashboard sessions, run:

```sh
turnstash_compose exec -T db sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DELETE FROM dashboard_sessions"'
```

To add a machine, open **Settings > Machines > Enrol machine** and run the generated `turnstash connect` command on that machine. Machine tokens and read-only API tokens continue to work without browser sessions. `turnstash enroll --admin-token` is unavailable with OIDC enabled.

To return to token authentication, clear `OIDC_ISSUER`, set a nonempty `ADMIN_TOKEN`, and recreate the server. This is an explicit configuration change, not an automatic fallback when authentik is unavailable.

## Back up

The database contains transcripts, normalized records, machine credentials, pricing, and deletion tombstones. Back up the database and `deploy/.env`. Protect both as sensitive data.

Run a backup before each upgrade and on a regular schedule appropriate to the data you can afford to lose:

```sh
(
  set -eu
  umask 077
  backup_dir="$HOME/turnstash-backups/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$backup_dir"
  turnstash_compose exec -T db sh -c \
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
    > "$backup_dir/database.dump"
  cp deploy/.env "$backup_dir/server.env"
  git rev-parse HEAD > "$backup_dir/revision"
  turnstash_compose exec -T db pg_restore --list < "$backup_dir/database.dump" > /dev/null
  printf 'Backup saved to %s\n' "$backup_dir"
)
```

Copy successful backups to encrypted storage outside the VPS. A dump listing checks that the archive can be read, but only a restore drill verifies recovery. Test the restore procedure on a separate host or isolated Compose project with a different port and volume.

## Upgrade

Record the current `SERVER_IMAGE` and Git revision, and take a backup first. The Git checkout does not select the server image. Set `SERVER_IMAGE` in `deploy/.env` to the reviewed release's digest or version tag, such as `ghcr.io/aquitano/aqt-turnstash-server:0.7.0`, check out the matching Git revision, then run:

```sh
turnstash_compose pull server
turnstash_compose up -d --wait --wait-timeout 300
turnstash_compose ps
```

Check the dashboard and run an agent sync. Migrations can change the database irreversibly. Reverting only the server image is not a safe rollback after a migration. To roll back, set `SERVER_IMAGE` back to the previous image and restore the pre-upgrade dump. Starting a newer image on the restored dump would migrate it again.

## Reprocess the archive

After a parser or model-alias correction, rebuild conversations and costs from the retained raw records with the server image's `reprocess` script:

```sh
turnstash_compose stop server
turnstash_compose run --rm server bun run --cwd apps/server reprocess
turnstash_compose up -d --wait --wait-timeout 300
```

Totals are incomplete until the worker finishes. See the [main README](../README.md#server) for what reprocessing keeps.

## Restore

The following commands replace the entire database selected by `POSTGRES_DB`, which defaults to `turnstash`. Keep a backup of the current database before restoring. Stop agent schedules during recovery and use the Git revision recorded with the backup. Set `SERVER_IMAGE` to the image in the backup's `server.env` before starting the server, because a newer image migrates the restored database again; without a pin there, the restore starts whatever `latest` points to now. Restore the other saved credentials to `deploy/.env` only if needed; retain the password of the target Postgres instance.

Set `restore_dump` to the chosen dump file, then run:

```sh
(
  set -eu
  restore_dump=/absolute/path/to/database.dump
  test -r "$restore_dump"
  turnstash_compose stop server
  turnstash_compose up -d --wait db
  turnstash_compose exec -T db sh -c \
    'dropdb -U "$POSTGRES_USER" --force --if-exists "$POSTGRES_DB"'
  turnstash_compose exec -T db sh -c \
    'createdb -U "$POSTGRES_USER" -T template0 "$POSTGRES_DB"'
  turnstash_compose exec -T db sh -c \
    'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --exit-on-error' \
    < "$restore_dump"
  turnstash_compose pull server
  turnstash_compose up -d --wait --wait-timeout 300
)
```

The restore creates the database from `template0` because ParadeDB adds objects to the default template. Restoring into the default template would conflict with those objects. See [PostgreSQL's restore guidance](https://www.postgresql.org/docs/17/backup-dump.html#BACKUP-DUMP-RESTORE).

If restore fails, keep the server stopped until recovery succeeds. Verify health, archived conversations, and a test agent sync before resuming agent schedules. Restoring an older backup loses records and machine registrations created after that backup. Agents may already have marked those records delivered, so do not assume they will upload the missing records again.
