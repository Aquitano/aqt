# Bank web UI

The archive browser behind `bank ui`, built with Vite, React and `@aqt/ui`. See
[the bank README](../../../README.md) for how it is served and embedded.

## Checks

Vite+ uses the repository's shared lint and format settings in the root
`vite.config.ts`. Run these commands from this directory:

```sh
bun run check       # formatting, type-aware lint and TypeScript checks
bun run test        # frontend tests through Vitest
bun run check:dist  # rebuild and verify the committed embedded UI assets
```
