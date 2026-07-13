# Data pipeline

Separate from the site build. Run manually (or on a schedule via a separate
GitHub Action, not yet added) to regenerate `public/data/counties.*.json`,
which is committed to the repo so the site build itself has no runtime
dependency on NOAA's servers.

## Source

NOAA NCEI county-level climate data (nClimDiv-derived), monthly max/min/avg
temperature and precipitation by county FIPS code, 1895–present:

- Bulk files: https://www.ncei.noaa.gov/pub/data/cirs/climdiv/
- Background: https://www.ncei.noaa.gov/news/noaa-offers-climate-data-counties
- Interactive explorer (for spot-checking): https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/county/mapping

County boundaries (TopoJSON) come from the `us-atlas` npm package, not this
pipeline — see `src/data/loadCountyData.ts`.

## Codebook (climdiv fixed-width files)

| Field             | Columns        | Notes                                       |
| ----------------- | -------------- | ------------------------------------------- |
| STATE-CODE        | 1–2            | 01–48                                       |
| DIVISION-NUMBER   | 3–5            |                                             |
| COUNTY-FIPS       | included in ID | 001–999                                     |
| ELEMENT-CODE      | —              | 02 = avg temp, 27 = max temp, 28 = min temp |
| YEAR              | —              |                                             |
| 12 monthly values | —              | fixed-width, missing = -99.90               |

## Usage

```bash
pip install -r requirements.txt --break-system-packages
python fetch_noaa_county_data.py     # -> raw/
python process_to_dataset.py         # -> ../public/data/counties.json
```

## Output contract

Output must match `CountyDataset` in `../src/types.ts`. If you change the
shape here, update that type too.
