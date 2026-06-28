import Foundation

// notch-hook: a tiny standalone hook client. The launcher in ~/.notch/bin execs
// this instead of the full app, so a hook costs a few ms (no AppKit/SwiftUI
// load). It reads the agent event, writes one JSON line to the agent socket,
// and exits 0 — never blocking the host agent. Shares HookClient + HookEnvelope
// with the app target.

HookClient.dispatch(Array(CommandLine.arguments.dropFirst()))
