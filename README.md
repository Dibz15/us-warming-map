# County Warming Trends

An interactive map showing temperature trends across US counties from 1895 to present. Each county is colored by its warming or cooling trend, and clicking on a county reveals a chart of its annual max/min temperatures and mean temperature trend over time.

## Features

- **Interactive Choropleth Map**: Explore all US counties colored by their temperature change slope (°F per decade)
- **Click/Hover Details**: Click on any county to see a detailed chart with annual max/min bounds and a trend line
- **Colorblind-Safe Palette**: A diverging blue-white-red color scale distinguishes cooling trends from warming trends, designed for accessibility
- **Offline Data**: All climate data is precomputed — no API calls or live data requests at runtime

## Data Source

Temperature data provided by [NOAA NCEI](https://www.ncei.noaa.gov/) (National Centers for Environmental Information). See the [data pipeline documentation](data-pipeline/README.md) for details on how the raw data is processed.

## Live Demo

A deployed version of this map is available on [GitHub Pages](https://dibz15.github.io/us-warming-map/).

## Local Development

```bash
# Install dependencies
npm install

# Build for production
npm run build     # outputs to dist/

# Preview the production build locally at http://localhost:5173
npm run preview
```

## Data Pipeline

The Python pipeline in `data-pipeline/` fetches and processes NOAA county-level climate data, then outputs `public/data/counties.*.json`. This file is preloaded at build so the frontend never needs to access external APIs at runtime.

To regenerate the dataset:

```bash
cd data-pipeline
pip install -r requirements.txt --break-system-packages
python fetch_noaa_county_data.py
python process_to_dataset.py
```

## Project Structure

```
src/
  chart/          Popup chart component (max/min/mean trend)
  data/           Data loading (TopoJSON + precomputed climate dataset)
  map/            Choropleth rendering + color scale
  styles/         Global CSS
  types.ts        Shared TypeScript types
data-pipeline/    Python scripts for fetching and processing NOAA data
public/data/      Generated dataset (committed to repo)
```

## Tech Stack

- **Build**: Vite + TypeScript
- **Map Rendering**: D3 (AlbersUSA projection, inline SVG rendering)
- **Charts**: D3 (scales, shapes, arrays, time formatting)
- **Data**: Precomputed JSON dataset + TopoJSON county boundaries
- **Deployment**: Static site deployed to GitHub Pages via Actions
