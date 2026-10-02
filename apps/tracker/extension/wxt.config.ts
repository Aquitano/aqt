import { defineConfig } from "wxt";

export default defineConfig({
  browser: "chrome",
  manifestVersion: 3,
  imports: false,
  srcDir: "src",
  manifest: {
    name: "aqt tracker",
    description:
      "Browsing memory: page views, active time and HTML captures into a local tracker server.",
    incognito: "not_allowed",
    // The public half of a key pins the extension id (gdhnnekkmghgkiikgmdodggcpgnmbpno)
    // on every machine, so the OIDC redirect URI and the server's origin check can
    // name one id. Loading unpacked needs no private key.
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0LrkCOtDw1Iz/lJdYF6MJnR3X/IAEsVoURySw2BZe1R8vdn72n3U58puydNHweeq/dbweR70pUuL/rPKGU97g1qetLXn6uT6Xt7batIp2FWd8S3bR0KlrRkR1baspE/gYbWikliM0KjpUcie2EdmWEkQ8Mw3jy85ctIUj7t8H9tiMWSAOhRdML2MwBXqYb2rRhBReMfEGZwe69Knh2aLBMiwNOJENwxFiblbBJoKorQkGlwPDFlWmwWK5Dvu7AyR96G8GT0Y70qbK5iOEbnLop1ifbOzYTGvS4EMMANXfI1PHU7VtBE+1cGpm8rFn7QeM5m4k1qU+T0K3uW5cgt8YQIDAQAB",
    omnibox: { keyword: "t" },
    permissions: ["storage", "tabs", "webNavigation", "idle", "alarms", "identity"],
    host_permissions: ["http://*/*", "https://*/*"],
  },
});
