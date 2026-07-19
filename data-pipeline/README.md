# Data pipeline

Separate from the site build. Run manually (or on a schedule via a separate
GitHub Action, not yet added) to regenerate `public/data/counties.meta.json`
and `public/data/counties.series.json`, both committed to the repo so the
site build itself has no runtime dependency on NOAA's servers.

## Source

NOAA NCEI county-level climate data (nClimDiv-derived), monthly max/min/avg
temperature and precipitation by county, 1895–present:

- Bulk files: https://www.ncei.noaa.gov/pub/data/cirs/climdiv/
- Background: https://www.ncei.noaa.gov/news/noaa-offers-climate-data-counties
- Interactive explorer (for spot-checking): https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/county/mapping

County boundaries (TopoJSON) come from the `us-atlas` npm package, not this
pipeline — see `src/data/loadCountyData.ts`.

County names and state names/abbreviations come from the Census Bureau's
national county reference file (ANSI codes), joined on FIPS — not derived
from anything in the NOAA files. See "County identity" below for why this
join has to happen on FIPS and not on NOAA's own state field.

## ⚠️ STATE-CODE is not FIPS

`climdiv` county/divisional files use a **legacy NOAA numbering scheme**
for state, not FIPS: the 48 contiguous states numbered 01–48 in straight
alphabetical order, with Hawaii and Alaska appended out of sequence as 49
and 50 (confirmed directly against NOAA's own `county-readme.txt` STATE
CODE TABLE — this is not the same ordering a general FIPS reference would
give you). NOAA code 02 is Arizona, not Alaska; code 03 is Arkansas, not
the unassigned FIPS 03.

Use `process_to_dataset.py`'s `noaa_state_to_fips()` to convert before
joining against the Census FIPS reference — do not join `STATE-CODE`
directly against a FIPS table. `noaa_state_to_fips()` raises on anything
outside 1–50 rather than guessing, since that range is exactly where a
parsing error or an unhandled edge case would show up.

## County identity

Because nClimDiv values are computed on _current_ county boundaries for
the entire period of record (see `docs/methodology.md` for why), there's
no historical-boundary reconciliation needed here — a county's 1895 value
and its 2025 value describe the same fixed area. What still needs care is
making sure all three of NOAA's data, the Census reference file, and
`us-atlas`'s TopoJSON agree on the same current set of ~3,107
counties/equivalents. Known trouble spots, worth spot-checking whenever
this pipeline is rerun against fresh source files:

- **DC**: doesn't get its own entry in NOAA's STATE CODE TABLE. Evidence
  (a third-party writeup of this exact dataset) suggests DC's single
  county is nested inside Maryland's bucket (NOAA state-order 18) under a
  synthetic, non-FIPS county identifier rather than DC's real FIPS county
  code (11001) — not yet confirmed against our own raw files. If DC data
  is missing or misattributed, check `state_code == 18` records for a
  `DIVISION-NUMBER` that isn't a real Maryland county FIPS.
- **Alaska / Hawaii**: sit outside the alphabetical 1–48 scheme (see
  above) and were added to nClimDiv later than the rest of the dataset —
  worth confirming county-level coverage is actually present and complete
  for both, not just that the state codes parse.
- **Connecticut**: the Census Bureau officially replaced CT's 8 counties
  with 9 planning regions as county-equivalents in 2022. Depending on the
  `us-atlas` version pulled and NOAA's current file, one source might lag
  the other on old vs. new CT geography — check this explicitly rather
  than assuming both sides updated together.
- Log any FIPS present in one source but not another during processing
  rather than silently dropping or guessing — with only ~3,100 entities
  total this is cheap to check by hand once per pipeline run.

## What TMAX/TMIN actually represent

`TMAX` and `TMIN` in the raw files are **monthly means** of daily
max/min temperature — the average of all the daily highs (or lows) in
that month, not the single hottest or coldest day. Nothing computed from
this pipeline represents a temperature record or a single-day extreme.
See `docs/methodology.md` for the full implications of this for every
downstream metric.

## Codebook (climdiv fixed-width files)

| Field             | Columns        | Notes                                                                                             |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| STATE-CODE        | 1–2            | NOT FIPS — NOAA order, 01–48 alphabetical (CONUS), 49 = Hawaii, 50 = Alaska. See crosswalk above. |
| DIVISION-NUMBER   | 3–5            | County FIPS (once STATE-CODE has been converted to real FIPS)                                     |
| COUNTY-FIPS       | included in ID | 001–999                                                                                           |
| ELEMENT-CODE      | —              | 02 = avg temp, 27 = max temp, 28 = min temp                                                       |
| YEAR              | —              |                                                                                                   |
| 12 monthly values | —              | fixed-width, missing = -99.90                                                                     |

## Derived fields computed in this pipeline

Beyond the raw monthly values, `process_to_dataset.py` computes and stores:

- `maxSlope` / `meanSlope` / `minSlope` — OLS trend, °F/decade, plus each
  slope's standard error (needed for DTR significance masking downstream)
- `dtrSlope` — trend of true DTR (`mean over months of (monthlyTmax − monthlyTmin)`,
  paired by month, month dropped from the average only if either side is
  missing that month — see `docs/methodology.md` for why this must be
  paired-then-averaged, not averaged-then-subtracted)
- `seasonalAmplitudeSlope` — trend of `(annual max − annual min)`, i.e.
  summer/winter convergence, **not** the same physical quantity as DTR
  despite the superficial similarity — see `docs/methodology.md`

True DTR requires annual mean `TMAX`/`TMIN` (not just the hottest/coldest
month values used for the `max`/`min` fields) to compute per year before
trending. If the per-year series shipped to the frontend doesn't already
carry annual mean `TMAX`/`TMIN`, this is where to add it — the frontend's
Period Delta mode currently can't offer DTR as a metric option for exactly
this reason.

## Usage

```bash
pip install -r requirements.txt --break-system-packages
python fetch_noaa_county_data.py     # -> raw/
python process_to_dataset.py         # -> ../public/data/counties.meta.json
                                      # -> ../public/data/counties.series.json
```

## Output contract

Two files, both keyed by 5-digit FIPS string (not an array — O(1) lookup,
not a scan):

- `counties.meta.json` — name, state, all slope/delta-relevant fields
  above, and precomputed percentile-clipped color domains. Small; loads
  first, drives the choropleth's initial paint.
- `counties.series.json` — per-year columnar data (`startYear` +
  parallel arrays, not one object per year — see `docs/methodology.md`
  for the reasoning). Larger; loads after/idle, needed for popup charts
  and Period Delta mode.

Both must match the corresponding types in `../src/types.ts`. If you
change either shape here, update those types too.
