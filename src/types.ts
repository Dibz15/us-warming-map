/**
 * Shape of the precomputed per-county dataset produced by
 * data-pipeline/process_to_dataset.py and served from public/data/.
 *
 * Kept intentionally small/flat so the whole dataset (~3,100 counties)
 * can be bundled as a single fetch rather than one request per county.
 */

export interface CountyYearRecord {
  year: number;
  tmax: number; // annual mean of daily max temp, °F
  tmin: number; // annual mean of daily min temp, °F
  true_dtr: number; // mean(Tmax_j - Tmin_j) across 12 months, °F
}

export interface CountyTrend {
  fips: string; // 5-digit FIPS code, joins to us-atlas TopoJSON `id`
  name: string;
  state: string;
  series: CountyYearRecord[];
  // Precomputed OLS slopes, °F/decade.
  // slopeTMax:    slope of the annual maximum temperature series
  // slopeTMean:   slope of the annual mean (tmax+tmin)/2 series (default)
  // slopeTMin:    slope of the annual minimum temperature series
  // slopeTrueDTR: OLS slope of the True DTR series — mean(Tmax_j - Tmin_j) per month
  // slopeSeasonalAmplitude: slope(tmax) - slope(tmin) — change in seasonal amplitude
  slopeTMax: number;
  slopeTMean: number;
  slopeTMin: number;
  slopeTrueDTR: number;
  slopeTrueDTRStdErr: number;
  slopeSeasonalAmplitude: number;
}

/** Temperature metric types for choropleth and period delta calculation. */
export type MetricType = "tmax" | "tmean" | "tmin" | "true_dtr" | "seasonal_amplitude";

/** Computation method for the choropleth. */
export type MethodType = "trend" | "period_delta";

/** Window selection for period delta calculation. */
export interface YearWindow {
  start: number;
  end: number;
}

/** State for period delta year range controls. */
export interface PeriodDeltaWindows {
  baseline: YearWindow;
  recent: YearWindow;
}

export interface CountyDataset {
  generatedAt: string; // ISO date the pipeline was last run
  sourceYearRange: [number, number];
  slopeDomains: Record<string, [number, number]>; // Percentile-based domains per temperature type
  counties: CountyTrend[];
}
