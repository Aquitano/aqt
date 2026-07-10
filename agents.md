# Agent Memory & Project Context

## 1. Project Patterns & Conventions

- Native macOS 26 app generated with XcodeGen from `project.yml`; no external Swift package dependencies by default.
- Managers are `@MainActor` observable objects. File/process/network work should use nonisolated helpers or dedicated workers and return to the main actor only to publish state.
- Build with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` because the system-selected developer directory may point at Command Line Tools.
- Keep the main app, `notch-hook`, and hostless logic tests independently buildable.

## 2. Lessons Learned & Gotchas

- The checked-in Xcode project must be regenerated after adding source or asset files: `xcodegen generate`.
- macOS XCTest execution needs access to `testmanagerd`; restricted sandboxes can compile tests but cannot run them.
- The `NotchTests` target compiles production source files directly, so helper signatures and its explicit source list must stay synchronized.
- Agent integration mutates user-owned CLI configuration; writes must be coordinated and preserve concurrent edits.

## 3. User Preferences

- Fix release blockers comprehensively, verify them, and commit the completed work.

## 4. Current Context / Scratchpad

- Release hardening completed: Debug/Release builds, static analysis, 87 logic tests, and native app launch smoke all pass. Remaining distribution work is tracked externally (system-wide media adapter and signed update pipeline).
