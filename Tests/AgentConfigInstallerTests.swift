import XCTest

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
}
