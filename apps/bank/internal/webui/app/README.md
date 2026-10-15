# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Checks

Vite+ uses the repository's shared lint and format settings in the root
`vite.config.ts`. Run these commands from this directory:

```sh
bun run check       # formatting, type-aware lint and TypeScript checks
bun run test        # frontend tests through Vitest
bun run check:dist  # rebuild and verify the committed embedded UI assets
```
