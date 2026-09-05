# ops

Deploy configuration for the services that run on the VPS.

Set `AQT_VPS_HOST` (ssh alias or `user@host`) and `AQT_VPS_ROOT` (checkout path on the box, default `/opt/aqt`).

```sh
ops/deploy.sh bank
ops/deploy.sh health
```

`deploy.sh` pulls the checkout on the VPS, requires `apps/<app>/.env` to exist there, and runs `docker compose up -d --build --wait` in the app's directory. Compose files live next to each app's Dockerfile, not here. Bank's data volume is LUKS and unlocked by hand, so it never auto-restarts.
