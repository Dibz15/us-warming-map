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
}

export interface CountyTrend {
  fips: string; // 5-digit FIPS code, joins to us-atlas TopoJSON `id`
  name: string;
  state: string;
  series: CountyYearRecord[];
  // Precomputed OLS slope of the mean((tmax+tmin)/2) series, °F/decade.
  // This is what drives the choropleth color scale.
  slopeFPerDecade: number;
}

export interface CountyDataset {
  generatedAt: string; // ISO date the pipeline was last run
  sourceYearRange: [number, number];
  counties: CountyTrend[];
}
