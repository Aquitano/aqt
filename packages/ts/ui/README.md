# @aqt/ui

The shared shadcn/ui components, design tokens and fonts for the aqt web apps. Components use Base UI and the base-maia style; `components.json` holds the shadcn config.

## Use it in an app

Import the stylesheet once from the app's own CSS, then the components by path:

```css
@import "@aqt/ui/styles/globals.css";
```

```tsx
import { Button } from "@aqt/ui/components/button";
```

Wrap the app in `ThemeProvider` from `@aqt/ui/components/theme-provider`. It follows the system theme by default and stores the choice; `ThemeToggle` switches between light, dark and system. Pass `defaultTheme="dark"` to start an app dark.

## Accent colour

Buttons, switches, checkboxes, sliders and the sidebar use `--primary`, which is neutral until an app sets `--brand`. Set it in the app's CSS after the import, with a foreground colour that reaches 4.5:1 on it. Mid-lightness oranges and greens need dark text; blues and violets take light text.

```css
:root {
  --brand: oklch(0.64 0.19 42);
  --brand-foreground: oklch(0.205 0 0);
}
```

## Charts

Use shadcn's `chart` component, built on Recharts, for area, bar, line, pie, radar and radial charts. The examples on ui.shadcn.com/charts work as they are; `preview/charts/` holds eight of them.

`--chart-1` to `--chart-5` hold Cloudflare Kumo's categorical palette: five distinct hues, so series in one chart stay apart. Override them in the app's CSS like `--brand`.

For a chart shadcn lacks, such as a Sankey, copy the component's source from Kumo (MIT, `packages/kumo/src/components/chart` in cloudflare/kumo) into `src/components` with its license notice, and point its colours, fonts and tooltip at our tokens and components. Don't depend on the Kumo package.

## Add or update components

Run the shadcn CLI from this directory: `bunx --bun shadcn@latest add <name>`. To compare an installed component with upstream, use `add <name> --diff src/components/<name>.tsx`. Upstream code is formatted with `bunx oxfmt` and has to pass the strict lint rules for `packages/`. Three kinds of local change sit on top of upstream and must survive an update: the badge's `success` and `warning` variants and the alert's `warning` variant, which use the `--success` and `--warning` tokens; the fixes the strict lint required in chart, sidebar, sonner and a few others; and fixes for upstream bugs. `AspectRatio` and `ToggleGroup` merge a caller's `style` instead of losing `--ratio` and `--gap`, `CalendarDayButton` attaches the ref it focuses, `Tabs` and `ToggleGroup` pass `orientation` on to Base UI instead of only setting `data-orientation`, and an `InputGroupAddon` click focuses a textarea as well as an input.

## Preview

`bun run dev` serves `preview/`, which renders the components in light and dark with an accent picker and sample charts.
