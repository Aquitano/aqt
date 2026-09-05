import Foundation
@testable import NotchCore
import Testing

/// With the filesystem root injected, `AgentConfigInstaller`'s install/uninstall
/// round-trip runs against a temp dir — so the subtle correctness bits (leaving a
/// user's own hooks intact, refusing to clobber an unreadable file, writing
/// through a symlinked config) are exercised without touching real dotfiles.
///
/// A class, not a struct: the temp dir is torn down in `deinit`.
final class AgentConfigInstallerTests {
    private let home: URL
    private var installer: AgentConfigInstaller

    private var settingsURL: URL {
        home.appendingPathComponent(".claude/settings.json")
    }

    init() throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        installer = AgentConfigInstaller(home: home)
    }

    deinit {
        try? FileManager.default.removeItem(at: home)
    }

    // MARK: - Helpers

    private func writeSettings(_ raw: String) throws {
        try FileManager.default.createDirectory(
            at: settingsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try raw.write(to: settingsURL, atomically: true, encoding: .utf8)
    }

    private func settingsObject(sourceLocation: SourceLocation = #_sourceLocation) throws -> [String: Any] {
        let data = try Data(contentsOf: settingsURL)
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any], sourceLocation: sourceLocation)
    }

    private func settingsText() throws -> String {
        try String(contentsOf: settingsURL, encoding: .utf8)
    }

    // MARK: - Round-trip

    @Test func freshInstallThenUninstallLeavesNoHooks() throws {
        #expect(!installer.claudeHooksInstalled())

        try installer.installClaudeHooks()
        #expect(installer.claudeHooksInstalled())
        #expect(try settingsText().contains("agent-hook"))

        try installer.removeClaudeHooks()
        #expect(!installer.claudeHooksInstalled())
        // Every event we added pruned back to empty, so the whole hooks key is gone.
        let hooks = try settingsObject()["hooks"]
        #expect(hooks == nil)
    }

    @Test func installPreservesAnExistingUserHook() throws {
        try writeSettings(#"""
        { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "my-own-thing" } ] } ] } }
        """#)

        try installer.installClaudeHooks()
        let afterInstall = try settingsText()
        #expect(afterInstall.contains("my-own-thing"), "user hook must survive install")
        #expect(afterInstall.contains("agent-hook"), "our hook must be added")

        try installer.removeClaudeHooks()
        let afterRemove = try settingsText()
        #expect(afterRemove.contains("my-own-thing"), "user hook must survive uninstall")
        #expect(!afterRemove.contains("agent-hook"), "our hook must be fully pruned")
    }

    @Test func preservesUserHookWhoseCommandContainsAgentHook() throws {
        // A user hook named like ~/bin/my-agent-hook.sh contains the substring
        // "agent-hook" but is not ours; a substring marker would silently delete it.
        try writeSettings(#"""
        { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "/Users/me/bin/my-agent-hook.sh" } ] } ] } }
        """#)

        try installer.installClaudeHooks()
        try installer.removeClaudeHooks()

        #expect(
            try settingsText().contains("my-agent-hook.sh"),
            "a user hook merely containing \"agent-hook\" must survive our uninstall"
        )
        #expect(!installer.claudeHooksInstalled())
    }

    // MARK: - statusLine usage wrapper

    @Test func usageUninstallRestoresOriginalStatusLineWhenSnapshotFileIsGone() throws {
        try writeSettings(#"""
        { "statusLine": { "type": "command", "command": "ccstatusline" } }
        """#)

        try installer.installClaudeUsage()
        #expect(installer.claudeUsageInstalled())

        // Simulate the user deleting ~/.notch while cleaning up, taking the on-disk
        // snapshot with it.
        try FileManager.default.removeItem(at: home.appendingPathComponent(".notch"))

        try installer.removeClaudeUsage()

        let line = try #require(settingsObject()["statusLine"] as? [String: Any])
        #expect(
            line["command"] as? String == "ccstatusline",
            "the user's original statusLine must be restored from the in-settings backup"
        )
    }

    @Test func usageUninstallRemovesWrapperWhenUserHadNoStatusLine() throws {
        try writeSettings("{}")

        try installer.installClaudeUsage()
        #expect(installer.claudeUsageInstalled())

        try FileManager.default.removeItem(at: home.appendingPathComponent(".notch"))
        try installer.removeClaudeUsage()

        let statusLine = try settingsObject()["statusLine"]
        #expect(statusLine == nil, "no original -> our wrapper is removed")
        #expect(
            try !(settingsText().contains("notchStatusLineBackup")),
            "our private backup key must not linger after uninstall"
        )
    }

    @Test func refusesToClobberUnreadableSettings() throws {
        let garbage = "{ not valid json"
        try writeSettings(garbage)

        let error = #expect(throws: AgentConfigInstaller.InstallerError.self) {
            try self.installer.installClaudeHooks()
        }
        #expect(error == .settingsUnreadable)
        #expect(try settingsText() == garbage, "the unreadable file must be left byte-for-byte untouched")
    }

    @Test func writesThroughASymlinkedConfig() throws {
        // Config is often a dotfiles-managed symlink; the write must replace the
        // real target's contents, not clobber the link with a plain file.
        let real = home.appendingPathComponent("dotfiles/claude-settings.json")
        try FileManager.default.createDirectory(at: real.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "{}".write(to: real, atomically: true, encoding: .utf8)

        try FileManager.default.createDirectory(
            at: settingsURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.createSymbolicLink(at: settingsURL, withDestinationURL: real)

        try installer.installClaudeHooks()

        let dest = try FileManager.default.destinationOfSymbolicLink(atPath: settingsURL.path)
        #expect(dest == real.path, "settings.json must remain a symlink to the real file")
        #expect(
            try String(contentsOf: real, encoding: .utf8).contains("agent-hook"),
            "the real target must receive the hooks"
        )
    }

    // MARK: - Generated plugin ownership

    private var openCodePluginURL: URL {
        home.appendingPathComponent(".config/opencode/plugins/notch.js")
    }

    private func writeFile(_ contents: String, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try contents.write(to: url, atomically: true, encoding: .utf8)
    }

    @Test func stalePluginIsRewrittenToTheCurrentRevision() throws {
        // What the shipped builds installed: our marker, but no revision.
        try writeFile("// notch agent watcher — auto-generated, do not edit\nold body\n", to: openCodePluginURL)
        #expect(installer.openCodePluginInstalled(), "a revisionless marker is still ours")

        try installer.installOpenCodePlugin()

        let rewritten = try String(contentsOf: openCodePluginURL, encoding: .utf8)
        #expect(
            rewritten.hasPrefix("// notch agent watcher r\(AgentConfigInstaller.pluginRevision) —"),
            "the stale file must be upgraded to the current revision"
        )
        #expect(!rewritten.contains("old body"))
    }

    @Test func foreignPluginIsNeitherOverwrittenNorRemoved() throws {
        let mine = "// my own opencode plugin\nexport default () => ({});\n"
        try writeFile(mine, to: openCodePluginURL)

        #expect(!installer.openCodePluginInstalled(), "an unmarked file is not our install")
        let error = #expect(throws: AgentConfigInstaller.InstallerError.self) {
            try self.installer.installOpenCodePlugin()
        }
        #expect(error == .pluginNotOurs(path: openCodePluginURL.path))
        #expect(try String(contentsOf: openCodePluginURL, encoding: .utf8) == mine)

        try installer.removeOpenCodePlugin()
        #expect(
            try String(contentsOf: openCodePluginURL, encoding: .utf8) == mine,
            "uninstall must not delete a file we never wrote"
        )
    }

    @Test func ohMyPiFansOutToExistingProfileAgentRoots() throws {
        let profiles = home.appendingPathComponent(".omp/profiles")
        let workAgent = profiles.appendingPathComponent("work/agent")
        try FileManager.default.createDirectory(at: workAgent, withIntermediateDirectories: true)
        // A profile that has no agent root of its own: we never create one.
        let bare = profiles.appendingPathComponent("bare")
        try FileManager.default.createDirectory(at: bare, withIntermediateDirectories: true)

        try installer.installOhMyPi()

        let mainIndex = home.appendingPathComponent(".omp/agent/extensions/notch/index.js")
        let workIndex = workAgent.appendingPathComponent("extensions/notch/index.js")
        #expect(FileManager.default.fileExists(atPath: mainIndex.path))
        #expect(
            try String(contentsOf: workIndex, encoding: .utf8)
                .hasPrefix("// notch agent watcher r\(AgentConfigInstaller.pluginRevision) —"),
            "the profile root must get the current extension"
        )
        #expect(
            !FileManager.default.fileExists(atPath: bare.appendingPathComponent("agent").path),
            "a missing profile agent root must not be created"
        )
        #expect(installer.ohMyPiInstalled())

        try installer.removeOhMyPi()
        #expect(!FileManager.default.fileExists(atPath: mainIndex.path))
        #expect(!FileManager.default.fileExists(atPath: workIndex.path))
        #expect(FileManager.default.fileExists(atPath: workAgent.path), "the profile itself must survive")
    }

    @Test func concurrentEditIsMergedInsteadOfOverwritten() throws {
        try writeSettings(#"{"theme":"dark"}"#)
        var intervened = false
        installer = AgentConfigInstaller(home: home) { url in
            guard !intervened else { return }
            intervened = true
            let data = try! Data(contentsOf: url)
            var object = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
            object["concurrentEdit"] = "preserve me"
            let changed = try! JSONSerialization.data(withJSONObject: object)
            try! changed.write(to: url, options: .atomic)
        }

        try installer.installClaudeHooks()

        let result = try settingsObject()
        #expect(result["concurrentEdit"] as? String == "preserve me")
        #expect(result["hooks"] != nil, "Notch's hook merge should retry against the new file")
    }
}
