# ops

Deploy configuration for the services that run on the VPS.

Set `AQT_VPS_HOST` (ssh alias or `user@host`) and `AQT_VPS_ROOT` (checkout path on the box, default `/opt/aqt`).

```sh
ops/deploy.sh bank
ops/deploy.sh health
```

`deploy.sh` pulls the checkout on the VPS and runs `docker compose up -d --build` in the app's directory. Bank's data volume is LUKS and unlocked by hand, so it never auto-restarts.
