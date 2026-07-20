# Methodology

Technical reference for what the underlying data represents and how each
metric and color mode on the map is calculated. Written for anyone
extending this project or trying to understand why a specific county shows
what it shows.

## 1. What the data actually is

### Source

Temperature values come from NOAA NCEI's **nClimDiv** county-level
dataset. Two properties of this dataset shape everything downstream:

**It's a modern grid product retrofit onto today's county boundaries, not
a historical administrative record.** nClimDiv values are area-weighted
averages of a 5km interpolated grid, built from station observations,
computed for each county's _current_ boundary for the entire period of
record back to 1895. This means there is no "historic county boundary"
problem to solve - a county's 1895 value and its 2025 value describe the
same fixed geographic area, even though the county's administrative
history (formation date, boundary changes, name changes) may be more
recent than 1895. It also means the values are a spatial average across
the whole county, not a single station reading - a county's number will
generally be less extreme than what any one specific point within it
recorded.

**It's monthly, not daily.** nClimDiv's `TMAX` and `TMIN` fields are the
_monthly mean_ of daily maximum/minimum temperature - the average of all
the daily highs (or lows) in that month, not the single hottest or coldest
day. This has a direct, important consequence: **none of the metrics on
this map represent record temperatures.** A county displaying a July
"max" of 90°F can still have individual July days well over 100°F; the
monthly mean simply averages those against cooler days in the same month.
Anyone building on this data for anything related to heat records,
extremes, or "how many days over X°F" needs a different, daily-resolution
data source (e.g. NOAA's `nClimGrid-Daily`) - this dataset structurally
cannot answer that question.

### County identity and the NOAA state-code pitfall

nClimDiv county/divisional files use a **legacy NOAA state numbering
scheme**, not FIPS: the 48 contiguous states numbered 01-48 in straight
alphabetical order, with Hawaii and Alaska appended out of sequence as 49
and 50 respectively (confirmed directly against NOAA's own
`county-readme.txt` STATE CODE TABLE). This is _not_ interchangeable with
standard FIPS state codes - naively joining on it produces silently wrong
results (e.g. NOAA code 02 is Arizona, not Alaska). See
`data-pipeline/process_to_dataset.py` for the full crosswalk and
`data-pipeline/README.md` for further detail, including the still-open
question of how DC is represented in the raw files (evidence suggests it's
nested under Maryland's bucket with a synthetic, non-FIPS county code
rather than getting its own state-level entry).

County-to-name/state mapping is joined on FIPS code against the Census
Bureau's national county reference file, not derived from any climate
data source - names and codes are two different provenance chains that
happen to share a join key.

## 2. Base metrics

Per county, per year, three series are retained:

| Field  | Definition                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| `max`  | The highest of the year's 12 monthly-mean `TMAX` values (i.e. the mean daily high of the year's hottest month) |
| `min`  | The lowest of the year's 12 monthly-mean `TMIN` values (i.e. the mean daily low of the year's coldest month)   |
| `mean` | `(max + min) / 2`                                                                                              |

Worth restating given how easy it is to misread: **`max` and `min` here
are not extremes within a day - they're extremes across the twelve
monthly averages of a year**, and they typically come from different
months entirely (max from a summer month, min from a winter month). This
matters for two derived metrics below that are easy to conflate if that
distinction isn't kept in mind.

## 3. Trend calculation methods

Two independent ways to turn a county's year-by-year series into a single
number for the choropleth.

### OLS trend (default, "Trend" mode)

Ordinary least-squares regression of the selected metric against year,
expressed as °F per decade. Uses every year in the record equally.

**Known limitation - regime shifts get diluted.** OLS fits a single
straight line across the whole 1895-present record. For a county whose
temperature genuinely rose, then fell, then partially recovered (which
describes real, documented phenomena - e.g. the US "warming hole," a
well-studied regime shift where the central/southeastern US cooled from
around 1958 onward even as the rest of the country warmed), a single OLS
slope necessarily blends the pre-shift and post-shift periods together,
producing a slope smaller in magnitude than either period would show on
its own. This isn't a bug in the calculation - it's an inherent property
of fitting one line to a non-monotonic series - but it means a small OLS
slope should not be read as "not much has changed here." Compare against
Period Delta mode, or a sub-period trend, for counties suspected of this
pattern.

**Alternatives considered, not implemented:** Theil-Sen estimation (median
of all pairwise slopes) is more robust to non-monotonic middle sections
and outlier years than OLS, while still producing one like-for-like
°F/decade number. It was considered as a drop-in replacement for OLS but
not implemented, in favor of adding Period Delta as a separate, distinctly
labeled metric instead of trying to make one slope number answer both
"what's the long-run rate" and "how different is now from then."

### Period Delta

```
periodDelta = mean(metric over recent window) - mean(metric over baseline window)
```

Computed entirely client-side, in °F (not °F/decade - a different unit
from Trend mode, since this isn't a rate). Baseline and recent windows are
user-selected year ranges, with a minimum 20-year gap enforced between
them.

Why a window average rather than a single start-year/end-year difference:
a single-year comparison is highly sensitive to which specific years land
at each end (a hot or cold outlier year at either endpoint swings the
whole result), which is the same fragility that makes single-year "no
warming since [that one hot year]" arguments unreliable. Averaging over a
multi-year window at each end smooths that out while still directly
answering "how different is now from then" - which is exactly the
question OLS's single slope can obscure for a non-monotonic county. This
also mirrors how NOAA/NASA/IPCC typically report "warming since [baseline
period]," rather than being a bespoke calculation invented for this
project.

Color domain for Period Delta mode is recomputed from the full set of
county deltas every time the metric, or either window, changes - it is
never reused from a different window or metric, since the spread of
values (and therefore the correct color domain) is different for every
window choice.

## 4. Derived metrics: DTR and seasonal amplitude

These are two genuinely different physical quantities that are easy to
conflate, because both are, loosely, "temperature spread within a year."

### Seasonal amplitude

```
seasonalAmplitude[year] = max[year] - min[year]
```

Using the base `max`/`min` fields above - i.e. the gap between the year's
hottest-month mean high and coldest-month mean low. This measures
**summer/winter convergence or divergence**: is the seasonal temperature
swing across the year getting bigger or smaller. Likely regional drivers
include snow-cover/ice-albedo feedback, changes in cold-air outbreak
frequency, and growing-season shifts - seasonal-scale mechanisms.

### True diurnal temperature range (DTR)

```
trueDtr[year] = mean over months j of ( monthlyTmax[year][j] - monthlyTmin[year][j] )
```

Computed by pairing each month's `TMAX` and `TMIN` _before_ averaging
(dropping a month from the average only if either side is missing that
month, rather than averaging each series independently over whatever
months happen to be available and subtracting the two results afterward -
the two approaches are mathematically identical given complete data, but
diverge silently whenever a month is missing on only one side). This
measures **day/night divergence**: is the gap between daily highs and
daily lows, within the same months, widening or narrowing. This is the
metric that corresponds to "DTR" and "diurnal asymmetric warming" in the
climate literature, and its documented regional drivers are different
from seasonal amplitude's - cloud cover, humidity, aerosols, and
land-use/irrigation changes affecting nighttime heat retention.

**These are not interchangeable, and an earlier version of this project
conflated them** - what was originally labeled "DTR" was actually seasonal
amplitude (built from `max`/`min`, which come from different months). The
naming was corrected once the distinction became clear during development.
If either metric appears elsewhere in the codebase or its history still
using the other's name, the definitions in this document are authoritative.

**Availability under Period Delta:** seasonal amplitude is directly
compatible, since it is derived from base fields already present in the
per-year series shipped to the frontend. True DTR is not yet available
under Period Delta mode, because computing it requires annual mean
`TMAX`/`TMIN` (not just the hottest/coldest month values), which the
per-year series doesn't currently include - it needs a pipeline addition
before it can be exposed there.

### DTR color encoding

DTR trend is shown with one scale: driven by the trend/delta in `trueDtr` itself, diverging around
zero: nights-warming-faster-than-days (DTR narrowing) toward purple;
days-warming-faster-than-nights (DTR widening) toward amber. Note that some coloration with DTR may not be
statistically meaningful (not separable from the noise of the distribution). An earlier version
grayed out these counties, but that masked any potential underlying trends. Full color has been restored
to all counties, just keep in mind that any specific value county DTR trend should be fully investigated
before making scientific judgements.

## 5. Known limitations

- **No record/extreme temperatures.** Every metric here derives from
  monthly means. This dataset cannot show single-day records, heatwave
  duration, or "days over X°F" - see `nClimGrid-Daily` (daily resolution,
  1951-present) if that's ever needed.
- **County values are spatial averages, not point observations.** A
  specific station or town within a county may show a notably different
  (often more extreme) trend than the county-wide average.
- **OLS understates regime-shift patterns**, as detailed above - a small
  OLS slope doesn't necessarily mean "not much has changed," particularly
  in regions with documented mid-century anomalies.
- **Some geographic coverage details are unverified.** Alaska (NOAA
  state-order 50) and Hawaii (49) sit outside the alphabetical 1-48
  scheme and were added to nClimDiv later than the rest of the dataset (due to missing
  data these two states are not included in the map);
  DC's representation in the raw files is inferred, not confirmed, to be
  nested under Maryland's state code with a synthetic county identifier.
  Connecticut's 2022 switch from 8 counties to 9 planning regions as
  county-equivalents is a similar area worth re-checking whenever the
  `us-atlas` boundary data or NOAA's source files are updated, in case one
  side lags the other.
