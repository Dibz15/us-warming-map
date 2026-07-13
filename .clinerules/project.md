# Project context

A static site: an interactive US map where each county is colored by the
slope (°F/decade) of its annual mean temperature trend, and hovering/tapping
a county pops up a small chart showing annual max/min temperature bounds
plus a mean trend line, 1895–present.

No backend. Site is a static Vite/TypeScript build deployed to GitHub Pages.
Climate data is precomputed offline by the Python pipeline in
`data-pipeline/` and committed as `public/data/counties.json` — the deployed
site never calls NOAA at runtime.

## Current state

This is a bare scaffold. `src/` files are stubs that throw
`not implemented`. Do not assume any dashboard functionality exists yet.

## Module boundaries (keep these separate)

- `src/data/` — fetching/parsing the precomputed dataset and TopoJSON
- `src/map/` — choropleth rendering + color scale, no chart logic
- `src/chart/` — the popup line chart, no map logic
- `data-pipeline/` — Python only, never imported by `src/`

## Conventions

- TypeScript strict mode is on (`tsconfig.json`). Don't add `any` or relax
  strict flags to make something compile — fix the types.
- Prefer the modular `d3-*` packages already in `package.json` (e.g.
  `d3-scale`, `d3-geo`) over the `d3` umbrella package, to keep the bundle
  small.
- Path alias `@/*` maps to `src/*`.
- Run `npm run lint` and `npm run build` before considering a task done —
  `build` includes a full `tsc --noEmit` type check.
- Don't commit `node_modules/`, `dist/`, or `data-pipeline/raw/`.

## Data integrity

- Never fabricate or hardcode placeholder climate numbers as if they were
  real NOAA data. If sample data is needed for UI development, generate it
  clearly labeled as synthetic (e.g. a `*.synthetic.json` fixture) and never
  let it silently end up in `public/data/`.
- The `CountyTrend.slopeFPerDecade` field must come from an actual
  regression over the series, computed in `data-pipeline/`, not estimated
  or eyeballed in frontend code.
- Cite the data source (NOAA NCEI) in the UI somewhere (footer/about) once
  that's built.

## Accessibility

- The diverging blue/white/red palette must remain distinguishable for
  common color-vision deficiencies — check any palette choice against a
  colorblind-safe diverging scale (e.g. ColorBrewer `RdBu`) rather than a
  naive red/blue interpolation.
- Popup charts and county selection must also work with keyboard/tap, not
  mouse-hover only.
