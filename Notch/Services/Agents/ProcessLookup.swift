import Darwin
import Foundation

/// Thin, stateless wrappers over `libproc` for agent liveness: enumerate pids,
/// resolve a pid's executable name and working directory, and walk the parent
/// chain (used to jump to the hosting terminal). Same-user processes only.
///
/// Technique reference: devmegablaster/Notch-Pilot (MIT). Reimplemented here
/// against the public `<libproc.h>` API.
struct ProcessLookup: Sendable {

    /// Every pid currently visible to this user's session.
    func allPIDs() -> [pid_t] {
        let needed = proc_listpids(UInt32(PROC_ALL_PIDS), 0, nil, 0)
        guard needed > 0 else { return [] }
        let capacity = Int(needed) / MemoryLayout<pid_t>.stride
        var pids = [pid_t](repeating: 0, count: capacity)
        let written = proc_listpids(UInt32(PROC_ALL_PIDS), 0, &pids, needed)
        guard written > 0 else { return [] }
        let count = Int(written) / MemoryLayout<pid_t>.stride
        return pids.prefix(count).filter { $0 > 0 }
    }

    /// Executable base name, or nil if the pid is gone / not inspectable.
    func name(of pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 2 * Int(MAXCOMLEN) + 1)
        let result = proc_name(pid, &buffer, UInt32(buffer.count))
        guard result > 0 else { return nil }
        return String(cString: buffer)
    }

    /// Full executable path.
    func path(of pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let result = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard result > 0 else { return nil }
        return String(cString: buffer)
    }

    /// Launch arguments via `KERN_PROCARGS2`. Used to recognize a CLI hosted by
    /// a generic runtime (e.g. `node …/claude-code/cli.js`) where the executable
    /// name alone doesn't identify the agent.
    func arguments(of pid: pid_t) -> [String] {
        procArgs2(of: pid)?.args ?? []
    }

    /// Environment of another process via `KERN_PROCARGS2` (same-uid only). Used to
    /// read terminal locators the tab exports (e.g. `WARP_FOCUS_URL`) so we can
    /// jump straight to the agent's tab.
    func environment(of pid: pid_t) -> [String: String] {
        guard let env = procArgs2(of: pid)?.env else { return [:] }
        var result: [String: String] = [:]
        for entry in env {
            guard let eq = entry.firstIndex(of: "=") else { continue }
            result[String(entry[..<eq])] = String(entry[entry.index(after: eq)...])
        }
        return result
    }

    /// Parse the `KERN_PROCARGS2` blob: Int32 argc, exec_path\0, padding, argc
    /// NUL-terminated args, then NUL-terminated `KEY=VALUE` env entries.
    private func procArgs2(of pid: pid_t) -> (args: [String], env: [String])? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else { return nil }

        let argc = buffer.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 0, as: Int32.self) }
        var i = MemoryLayout<Int32>.size
        while i < size && buffer[i] != 0 { i += 1 }   // skip exec_path
        while i < size && buffer[i] == 0 { i += 1 }   // skip padding

        func nextToken() -> String? {
            let start = i
            while i < size && buffer[i] != 0 { i += 1 }
            defer { i += 1 }
            return i > start ? String(bytes: buffer[start..<i], encoding: .utf8) : nil
        }

        var args: [String] = []
        for _ in 0..<Int(argc) where i < size {
            if let token = nextToken() { args.append(token) }
        }
        var env: [String] = []
        while i < size {
            if let token = nextToken() { env.append(token) }
        }
        return (args, env)
    }

    /// Parent pid via `sysctl(KERN_PROC_PID)` — the same source `ps` reads.
    /// `proc_pidinfo` refuses a process owned by another user, and every
    /// Ghostty/Terminal window has a setuid-root `login` between the shell and
    /// the app: a walk built on it stops one step short of the window, so the
    /// terminal is never raised and a live session looks detached.
    func ppid(of pid: pid_t) -> pid_t? {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
        return info.kp_eproc.e_ppid
    }

    func startDate(of pid: pid_t) -> Date? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        let seconds = TimeInterval(info.pbi_start_tvsec)
        let microseconds = TimeInterval(info.pbi_start_tvusec) / 1_000_000
        return Date(timeIntervalSince1970: seconds + microseconds)
    }

    /// Controlling terminal device of a process (e.g. "/dev/ttys003"), or nil if
    /// it has none (daemonized / no pty). The most portable cross-terminal handle.
    func controllingTTY(of pid: pid_t) -> String? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        let tdev = info.e_tdev
        guard tdev != 0, tdev != UInt32.max else { return nil }
        guard let name = devname(dev_t(tdev), S_IFCHR) else { return nil }
        return "/dev/" + String(cString: name)
    }

    /// Current working directory via `PROC_PIDVNODEPATHINFO`, normalized.
    func cwd(of pid: pid_t) -> String? {
        var info = proc_vnodepathinfo()
        let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
        let result = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size)
        guard result == size else { return nil }
        let path = withUnsafePointer(to: &info.pvi_cdir.vip_path) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) {
                String(cString: $0)
            }
        }
        return path.isEmpty ? nil : normalize(path)
    }

    /// Paths of vnode-backed files currently open by a process. Claude normally
    /// keeps its active transcript open, which gives us the missing pid → session-id
    /// link when multiple sessions share one working directory.
    func openFilePaths(of pid: pid_t) -> [String] {
        let needed = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
        guard needed > 0 else { return [] }
        let capacity = Int(needed) / MemoryLayout<proc_fdinfo>.stride
        var descriptors = [proc_fdinfo](repeating: proc_fdinfo(), count: capacity)
        let written = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, &descriptors, needed)
        guard written > 0 else { return [] }

        let count = Int(written) / MemoryLayout<proc_fdinfo>.stride
        return descriptors.prefix(count).compactMap { descriptor in
            guard descriptor.proc_fdtype == UInt32(PROX_FDTYPE_VNODE) else { return nil }
            var info = vnode_fdinfowithpath()
            let size = Int32(MemoryLayout<vnode_fdinfowithpath>.size)
            guard proc_pidfdinfo(pid, descriptor.proc_fd, PROC_PIDFDVNODEPATHINFO, &info, size) == size else {
                return nil
            }
            let path = withUnsafePointer(to: &info.pvip.vip_path) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) {
                    String(cString: $0)
                }
            }
            return path.isEmpty ? nil : normalize(path)
        }
    }

    /// Walk pid → ppid (capped) until `match` accepts a process, returning that
    /// pid. Used to find the terminal that hosts an agent.
    func firstAncestor(of pid: pid_t, maxDepth: Int = 12, where match: (pid_t) -> Bool) -> pid_t? {
        var current = pid
        for _ in 0..<maxDepth {
            if match(current) { return current }
            guard let parent = ppid(of: current), parent > 1, parent != current else { return nil }
            current = parent
        }
        return nil
    }

    /// Strip the `/private` prefix macOS adds to `/tmp` and `/var`, so cwds from
    /// `libproc` compare equal to the paths agents report.
    func normalize(_ path: String) -> String {
        if path.hasPrefix("/private/") {
            return String(path.dropFirst("/private".count))
        }
        return path
    }
}
