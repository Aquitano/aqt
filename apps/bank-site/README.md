# bank-site

The landing page for bank, under its product name. A static React site built with Vite, Tailwind and GSAP.

```sh
bun run --cwd apps/bank-site dev      # http://localhost:4310
bun run --cwd apps/bank-site build    # static files in dist/
```

The product name, the command shown in examples and the repository links live in `src/brand.ts`. The hosted waitlist form appears only when `VITE_WAITLIST_URL` is set at build time; it posts `{"email"}` as JSON to that URL.

All terminal output on the page is sample data.
