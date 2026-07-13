# County Warming Trends

Interactive US map of annual max/min temperature trends by county, 1895–present.
Each county is colored by the slope of its warming trend; hovering/tapping a
county shows a small chart of the annual max/min bounds and a mean trend line.

Status: **scaffold only** — no dashboard implemented yet.

## Stack

- **Build:** Vite + TypeScript, deployed as a static site to GitHub Pages
- **Map:** `d3-geo` (AlbersUSA projection) + `topojson-client` + `us-atlas`
  (county boundary TopoJSON), rendered as inline SVG — no basemap tiles
- **Charts:** `d3-scale` / `d3-shape` / `d3-array` / `d3-time-format` for the
  popup line chart
- **Data pipeline:** Python (`data-pipeline/`), run offline/manually, output
  committed as `public/data/counties.json`

## Why this stack

The map is a fixed US county choropleth, not a pannable/zoomable basemap, so
a classic D3 SVG map (`us-atlas` + `d3-geo`) is a better fit than a tile-based
library like Leaflet or MapLibre — smaller bundle, no tile requests, and
trivial to style per-county by data value.

## Project layout

```
src/
  data/     data loading (TopoJSON + precomputed climate dataset)
  map/      choropleth rendering + diverging color scale
  chart/    popup max/min/mean trend chart
  styles/   global CSS
  types.ts  shared dataset types
data-pipeline/   Python: NOAA fetch + processing -> public/data/counties.json
public/data/     generated dataset (committed, not fetched at runtime)
```

## Getting started

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check + production build to dist/
npm run lint
```

Data pipeline (only needed when regenerating `public/data/counties.json`):

```bash
cd data-pipeline
pip install -r requirements.txt --break-system-packages
python fetch_noaa_county_data.py
python process_to_dataset.py
```

## Deployment

`.github/workflows/deploy.yml` builds and deploys `dist/` to GitHub Pages on
every push to `main`. In the repo settings, set **Pages → Source** to
"GitHub Actions". `vite.config.ts` auto-derives the base path from
`GITHUB_REPOSITORY` for project pages (`username.github.io/repo/`); if this
becomes a user/org page (`username.github.io`) instead, hardcode `base: "/"`.

## Data source

NOAA NCEI county-level climate data (nClimDiv-derived). See
`data-pipeline/README.md` for the exact source URLs and file codebook.

## Dev container

`.devcontainer/` provides Node 22 + Python 3.12 with the Cline VS Code
extension preinstalled, for a consistent Cline + local coding agent setup.
