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

    /// Pids whose executable base name equals `name` (e.g. "claude").
    func pids(named name: String) -> [pid_t] {
        allPIDs().filter { self.name(of: $0) == name }
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

    /// Parent pid via `PROC_PIDTBSDINFO`.
    func ppid(of pid: pid_t) -> pid_t? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        let result = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size)
        guard result == size else { return nil }
        return pid_t(info.pbi_ppid)
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
