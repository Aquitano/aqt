# Performance and profiling plan

Starboard's critical path is the global event-tap callback. It must finish well
inside macOS's tap timeout and should not allocate or perform accessibility,
workspace, filesystem, or UI work synchronously.

## Prepared instrumentation

The `Performance` signpost category records four intervals:

- `Event routing`: complete synchronous event-tap work.
- `Window enumeration`: uncached `CGWindowListCopyWindowInfo` calls.
- `Search ranking`: fuzzy scoring and result sorting.
- `Installed app scan`: the background filesystem scan.

Window enumeration also has a 100 ms coalescing cache. Space changes invalidate
it immediately; the short lifetime avoids stale results after ordinary window
changes while collapsing duplicate enumeration during one interaction.

## Baseline procedure

1. Build a profiling binary with `make profile-build`.
2. Grant that binary Accessibility and Screen Recording permission.
3. Open Instruments with the **Points of Interest**, **Time Profiler**, and
   **Allocations** instruments and attach to Starboard.
4. Record these scenarios separately for at least 30 seconds each:
   - rapid Right Command letter switching;
   - app search with 1, 2, 5, and 10-character queries;
   - window search/cycling with 10, 50, and 100 visible windows;
   - key-hint display with at least 20 running apps;
   - a cold installed-app scan.
5. Export each trace with the macOS version, hardware, app count, window count,
   keyboard layout, and build commit in its filename.

## Initial budgets

Use p50/p95/p99, not only averages. Treat regressions larger than 10% as worth
investigating even when still below budget.

| Interval | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| Event routing | < 0.10 ms | < 0.25 ms | < 0.50 ms |
| Search ranking (500 candidates) | < 0.50 ms | < 1.0 ms | < 2.0 ms |
| Window enumeration (uncached) | < 3 ms | < 8 ms | < 15 ms |

The callback should show zero persistent allocations per ordinary key event.
Any AX call, application scan, disk I/O, or main-thread wait in `Event routing`
is a correctness issue, regardless of the measured duration.

## Repeatable microbenchmarks

`make benchmark` runs the separate `StarboardBenchmarks` XCTest bundle in
Release configuration. It is intentionally not part of `make test`, so normal
verification does not silently collect noisy local performance numbers.

Before comparing results: quit heavy background applications, disable Low Power
Mode, use the same machine and macOS build, run once to warm compiler/runtime
caches, then retain the `.xcresult` bundle. Compare medians over at least five
invocations. XCTest numbers are a regression alarm; Instruments remains the
source for explaining a regression.
