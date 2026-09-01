import XCTest
@testable import NotchCore

/// With the filesystem root injected, `AgentConfigInstaller`'s install/uninstall
/// round-trip runs against a temp dir — so the subtle correctness bits (leaving a
/// user's own hooks intact, refusing to clobber an unreadable file, writing
/// through a symlinked config) are exercised without touching real dotfiles.
final class AgentConfigInstallerTests: XCTestCase {

    private var home: URL!
    private var installer: AgentConfigInstaller!

    private var settingsURL: URL { home.appendingPathComponent(".claude/settings.json") }

    override func setUpWithError() throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        installer = AgentConfigInstaller(home: home)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: home)
    }

    // MARK: - Helpers

    private func writeSettings(_ raw: String) throws {
        try FileManager.default.createDirectory(at: settingsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try raw.write(to: settingsURL, atomically: true, encoding: .utf8)
    }

    private func settingsObject(file: StaticString = #filePath, line: UInt = #line) throws -> [String: Any] {
        let data = try Data(contentsOf: settingsURL)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], file: file, line: line)
    }

    private func settingsText() throws -> String {
        try String(contentsOf: settingsURL, encoding: .utf8)
    }

    // MARK: - Round-trip

    func testFreshInstallThenUninstallLeavesNoHooks() throws {
        XCTAssertFalse(installer.claudeHooksInstalled())

        try installer.installClaudeHooks()
        XCTAssertTrue(installer.claudeHooksInstalled())
        XCTAssertTrue(try settingsText().contains("agent-hook"))

        try installer.removeClaudeHooks()
        XCTAssertFalse(installer.claudeHooksInstalled())
        // Every event we added pruned back to empty, so the whole hooks key is gone.
        XCTAssertNil(try settingsObject()["hooks"])
    }

    func testInstallPreservesAnExistingUserHook() throws {
        try writeSettings(#"""
        { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "my-own-thing" } ] } ] } }
        """#)

        try installer.installClaudeHooks()
        let afterInstall = try settingsText()
        XCTAssertTrue(afterInstall.contains("my-own-thing"), "user hook must survive install")
        XCTAssertTrue(afterInstall.contains("agent-hook"), "our hook must be added")

        try installer.removeClaudeHooks()
        let afterRemove = try settingsText()
        XCTAssertTrue(afterRemove.contains("my-own-thing"), "user hook must survive uninstall")
        XCTAssertFalse(afterRemove.contains("agent-hook"), "our hook must be fully pruned")
    }

    func testPreservesUserHookWhoseCommandContainsAgentHook() throws {
        // A user hook named like ~/bin/my-agent-hook.sh contains the substring
        // "agent-hook" but is not ours; a substring marker would silently delete it.
        try writeSettings(#"""
        { "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "/Users/me/bin/my-agent-hook.sh" } ] } ] } }
        """#)

        try installer.installClaudeHooks()
        try installer.removeClaudeHooks()

        XCTAssertTrue(try settingsText().contains("my-agent-hook.sh"),
                      "a user hook merely containing \"agent-hook\" must survive our uninstall")
        XCTAssertFalse(installer.claudeHooksInstalled())
    }

    // MARK: - statusLine usage wrapper

    func testUsageUninstallRestoresOriginalStatusLineWhenSnapshotFileIsGone() throws {
        try writeSettings(#"""
        { "statusLine": { "type": "command", "command": "ccstatusline" } }
        """#)

        try installer.installClaudeUsage()
        XCTAssertTrue(installer.claudeUsageInstalled())

        // Simulate the user deleting ~/.notch while cleaning up, taking the on-disk
        // snapshot with it.
        try FileManager.default.removeItem(at: home.appendingPathComponent(".notch"))

        try installer.removeClaudeUsage()

        let line = try XCTUnwrap(settingsObject()["statusLine"] as? [String: Any])
        XCTAssertEqual(line["command"] as? String, "ccstatusline",
                       "the user's original statusLine must be restored from the in-settings backup")
    }

    func testUsageUninstallRemovesWrapperWhenUserHadNoStatusLine() throws {
        try writeSettings("{}")

        try installer.installClaudeUsage()
        XCTAssertTrue(installer.claudeUsageInstalled())

        try FileManager.default.removeItem(at: home.appendingPathComponent(".notch"))
        try installer.removeClaudeUsage()

        XCTAssertNil(try settingsObject()["statusLine"], "no original -> our wrapper is removed")
        XCTAssertFalse(try settingsText().contains("notchStatusLineBackup"),
                       "our private backup key must not linger after uninstall")
    }

    func testRefusesToClobberUnreadableSettings() throws {
        let garbage = "{ not valid json"
        try writeSettings(garbage)

        XCTAssertThrowsError(try installer.installClaudeHooks()) { error in
            XCTAssertEqual(error as? AgentConfigInstaller.InstallerError, .settingsUnreadable)
        }
        XCTAssertEqual(try settingsText(), garbage, "the unreadable file must be left byte-for-byte untouched")
    }

    func testWritesThroughASymlinkedConfig() throws {
        // Config is often a dotfiles-managed symlink; the write must replace the
        // real target's contents, not clobber the link with a plain file.
        let real = home.appendingPathComponent("dotfiles/claude-settings.json")
        try FileManager.default.createDirectory(at: real.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "{}".write(to: real, atomically: true, encoding: .utf8)

        try FileManager.default.createDirectory(at: settingsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: settingsURL, withDestinationURL: real)

        try installer.installClaudeHooks()

        let dest = try FileManager.default.destinationOfSymbolicLink(atPath: settingsURL.path)
        XCTAssertEqual(dest, real.path, "settings.json must remain a symlink to the real file")
        XCTAssertTrue(try String(contentsOf: real, encoding: .utf8).contains("agent-hook"),
                      "the real target must receive the hooks")
    }

    // MARK: - Generated plugin ownership

    private var openCodePluginURL: URL { home.appendingPathComponent(".config/opencode/plugins/notch.js") }

    private func writeFile(_ contents: String, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try contents.write(to: url, atomically: true, encoding: .utf8)
    }

    func testStalePluginIsRewrittenToTheCurrentRevision() throws {
        // What the shipped builds installed: our marker, but no revision.
        try writeFile("// notch agent watcher — auto-generated, do not edit\nold body\n", to: openCodePluginURL)
        XCTAssertTrue(installer.openCodePluginInstalled(), "a revisionless marker is still ours")

        try installer.installOpenCodePlugin()

        let rewritten = try String(contentsOf: openCodePluginURL, encoding: .utf8)
        XCTAssertTrue(rewritten.hasPrefix("// notch agent watcher r\(AgentConfigInstaller.pluginRevision) —"),
                      "the stale file must be upgraded to the current revision")
        XCTAssertFalse(rewritten.contains("old body"))
    }

    func testForeignPluginIsNeitherOverwrittenNorRemoved() throws {
        let mine = "// my own opencode plugin\nexport default () => ({});\n"
        try writeFile(mine, to: openCodePluginURL)

        XCTAssertFalse(installer.openCodePluginInstalled(), "an unmarked file is not our install")
        XCTAssertThrowsError(try installer.installOpenCodePlugin()) { error in
            XCTAssertEqual(error as? AgentConfigInstaller.InstallerError,
                           .pluginNotOurs(path: openCodePluginURL.path))
        }
        XCTAssertEqual(try String(contentsOf: openCodePluginURL, encoding: .utf8), mine)

        try installer.removeOpenCodePlugin()
        XCTAssertEqual(try String(contentsOf: openCodePluginURL, encoding: .utf8), mine,
                       "uninstall must not delete a file we never wrote")
    }

    func testOhMyPiFansOutToExistingProfileAgentRoots() throws {
        let profiles = home.appendingPathComponent(".omp/profiles")
        let workAgent = profiles.appendingPathComponent("work/agent")
        try FileManager.default.createDirectory(at: workAgent, withIntermediateDirectories: true)
        // A profile that has no agent root of its own: we never create one.
        let bare = profiles.appendingPathComponent("bare")
        try FileManager.default.createDirectory(at: bare, withIntermediateDirectories: true)

        try installer.installOhMyPi()

        let mainIndex = home.appendingPathComponent(".omp/agent/extensions/notch/index.js")
        let workIndex = workAgent.appendingPathComponent("extensions/notch/index.js")
        XCTAssertTrue(FileManager.default.fileExists(atPath: mainIndex.path))
        XCTAssertTrue(try String(contentsOf: workIndex, encoding: .utf8)
            .hasPrefix("// notch agent watcher r\(AgentConfigInstaller.pluginRevision) —"),
            "the profile root must get the current extension")
        XCTAssertFalse(FileManager.default.fileExists(atPath: bare.appendingPathComponent("agent").path),
                       "a missing profile agent root must not be created")
        XCTAssertTrue(installer.ohMyPiInstalled())

        try installer.removeOhMyPi()
        XCTAssertFalse(FileManager.default.fileExists(atPath: mainIndex.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: workIndex.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: workAgent.path), "the profile itself must survive")
    }

    func testConcurrentEditIsMergedInsteadOfOverwritten() throws {
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
        XCTAssertEqual(result["concurrentEdit"] as? String, "preserve me")
        XCTAssertNotNil(result["hooks"], "Notch's hook merge should retry against the new file")
    }
}
