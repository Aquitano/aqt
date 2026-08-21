# Starboard

Switch apps by holding **Right ⌘** and pressing a letter. A native macOS menu bar utility with Raycast-inspired design. Feature spec and implementation phases live in [BATTLEPLAN.md](BATTLEPLAN.md).

## Development

Requires Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```sh
make gen     # generate Starboard.xcodeproj from project.yml
make build
make run     # relaunches the app
make test
```

The app needs the **Accessibility** permission (event tap) and optionally **Screen Recording** (window titles). With ad-hoc signing, Accessibility grants reset on each rebuild — set `CODE_SIGN_IDENTITY` in `project.yml` to a real development certificate for a stable grant.
