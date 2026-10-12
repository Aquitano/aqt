# pdf

A copy of [ledongthuc/pdf](https://github.com/ledongthuc/pdf) at `6c8c28e` with the open pull request [#93](https://github.com/ledongthuc/pdf/pull/93) applied, plus one local guard. #93 bounds what a malformed file can make the parser allocate, recurse into or loop over. The guard stops `readPrevXrefs` at a cross-reference section it has already read, so a looping `/Prev` chain no longer hangs `NewReader`. Upstream does not have it; [#96](https://github.com/ledongthuc/pdf/pull/96), which offered it, was closed.

Without these, one malformed PDF can hang bank or attic, or kill them with a stack overflow or an out-of-memory error, neither of which `recover` catches. Bank extracts blobs one after another, so a hang stalls its whole extraction run on the same file every time.

Once #93 is released upstream, the copy only carries the guard. Keep it until upstream bounds the `/Prev` walk; then delete this directory, import `github.com/ledongthuc/pdf` in `../../pdf.go` again, and remove the exclusions for this path from the root `.golangci.yml`.
