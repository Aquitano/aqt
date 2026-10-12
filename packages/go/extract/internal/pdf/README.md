# pdf

A copy of [ledongthuc/pdf](https://github.com/ledongthuc/pdf) at `6c8c28e` with two open pull requests applied:

- [#93](https://github.com/ledongthuc/pdf/pull/93) bounds what a malformed file can make the parser allocate, recurse into or loop over.
- [#96](https://github.com/ledongthuc/pdf/pull/96) stops a looping xref `/Prev` chain from hanging `NewReader`.

Without them, one malformed PDF can hang bank or attic, or kill them with a stack overflow or an out-of-memory error, neither of which `recover` catches.

Once both are released upstream, delete this directory, import `github.com/ledongthuc/pdf` in `../../pdf.go` again, and remove the exclusions for this path from the root `.golangci.yml`.
