# System-wide Now Playing bridge

## Provenance and build model

- Upstream: `https://github.com/ejbills/mediaremote-adapter`
- Pinned revision: `cf30c4f1af29b5829d859f088f8dbdf12611a046`
- Launcher source: upstream `run.pl`, audited and reduced to the symbols Notch uses
- Bundled launcher SHA-256: `30a7508f76394120993b333eed425c70b7b090a7a0b9fc5b420212422dd9b1a7`

Xcode resolves the exact package revision from `project.yml`. Its dynamic framework is copied
to `Contents/Frameworks` with CodeSignOnCopy, while `link: false` keeps it out of the app's load
commands. The launcher is an explicit app resource because SwiftPM does not copy a package
resource bundle for a non-linked dependency.

`Scripts/verify_media_adapter.sh` fails every app build if the launcher checksum changes, the
framework or required C symbols are missing, either app executable links the framework, or an
existing embedded signature is invalid. Release signing and notarization remain part of the
separate distribution-pipeline work.

There is no runtime download or external override. This avoids unverified binaries and removes
all quarantine-bypass handling from the product.

## Runtime behavior

1. Notch starts the Music/Spotify AppleScript controller immediately.
2. Off-main, `/usr/bin/perl … mediaremote-adapter.pl …/MediaRemoteAdapter get` must return
   `NIL` or a valid `data` envelope within five seconds.
3. On success, Notch starts the push-driven `loop` stream and routes controls over its stdin.
4. Missing artifacts, bad ABI/JSON, timeout, or process exit keeps or restores the scripting
   controller. Settings shows the reason.

The parser handles partial payloads, converts microseconds to seconds, advances timestamped
playing positions, clears `NIL`, and refuses smaller artwork updates for the same track.

## Validation matrix

Validated on macOS 26.5.2 arm64 on 2026-07-10:

| Check | Result |
|---|---|
| Pinned package resolution and clean framework build | Pass |
| Framework embedded but absent from app load commands | Pass |
| Bundled launcher checksum and required exported symbols | Pass |
| Development-signed app + framework, same TeamIdentifier, strict verification | Pass |
| Real one-shot `get` while idle | Pass (`NIL`, exit 0) |
| Real one-shot browser frame | Pass (Brave source identity, timing, artwork) |
| Real push `loop` initial frame | Pass (`NIL`) |
| Playing, paused, artwork, and partial payload variants | Covered by wire-format tests |

Before distributing a macOS point release, perform the live-source/control matrix in
`docs/archive/POLISH_PLAN.md`; those checks require installed apps, user media, and audible transport
changes and are intentionally not automated.

## Rollback

If Apple changes MediaRemote or the pinned bridge regresses:

1. Turn off **Settings → Media → System-wide Now Playing** and relaunch. Music and Spotify
   continue through AppleScript.
2. Revert the package revision in `project.yml` only after auditing its protocol and exported
   symbols.
3. If the launcher changes, update it deliberately and replace the verifier's SHA-256.
4. Run Debug/Release builds, analysis, tests, `get`, `loop`, and the live-source matrix before
   shipping the new pin.
