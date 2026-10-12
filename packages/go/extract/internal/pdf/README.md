# pdf

A copy of [ledongthuc/pdf](https://github.com/ledongthuc/pdf) at `6c8c28e` with the open pull request [#93](https://github.com/ledongthuc/pdf/pull/93) applied. It bounds what a malformed file can make the parser allocate, recurse into or loop over.

Without it, one malformed PDF can hang bank or attic, or kill them with a stack overflow or an out-of-memory error, neither of which `recover` catches. A cross-reference `/Prev` chain that loops back still hangs `NewReader`, as it does upstream.

Once #93 is released upstream, delete this directory, import `github.com/ledongthuc/pdf` in `../../pdf.go` again, and remove the exclusions for this path from the root `.golangci.yml`.
