// Loads and merges the precomputed NOAA climate dataset (produced by
// data-pipeline/process_to_dataset.py) from two JSON files:
//   - public/data/counties.meta.json   (name, state, slope per county)
//   - public/data/counties.series.json (columnar tmean/tmax/tmin/true_dtr arrays)
//
// Merges them into a single CountyDataset matching the type in types.ts.

import type { CountyDataset } from "@/types";

/** Shape of counties.meta.json */
interface MetaFile {
  generatedAt: string;
  sourceYearRange: [number, number];
  slopeDomains: Record<string, [number, number]>;
  counties: Record<
    string,
    {
      name: string;
      state: string;
      tslopeFPerDecade_tmean?: number;
      tslopeFPerDecade_tmax?: number;
      tslopeFPerDecade_tmin?: number;
      tslopeFPerDecade_true_dtr?: number;
      tslopeStdErr_tmax?: number;
      tslopeStdErr_tmin?: number;
      tslopeStdErr_true_dtr?: number;
    }
  >;
}

/** Temperature type selector for the choropleth color mapping. */
export type SlopeType = "tmax" | "tmean" | "tmin" | "true_dtr" | "seasonal_amplitude";

/** Shape of counties.series.json */
interface SeriesFile {
  startYear: number;
  series: Record<
    string,
    {
      tmean: number[] | null;
      tmax: number[] | null;
      tmin: number[] | null;
      true_dtr: number[] | null;
    }
  >;
}

/**
 * Merges meta and series data into the unified CountyDataset format.
 * Series values are stored as tenths of °F in the pipeline files, so we
 * divide by 10 to convert back to real degrees.
 */
function mergeMetaAndSeries(meta: MetaFile, series: SeriesFile): CountyDataset {
  const counties: CountyDataset["counties"] = [];

  for (const [fips, metaEntry] of Object.entries(meta.counties)) {
    const seriesEntry = series.series[fips];
    if (!seriesEntry) continue; // skip missing

    const yearCount = seriesEntry.tmean?.length ?? 0;

    const rawSeries: CountyDataset["counties"][number]["series"] = [];
    for (let i = 0; i < yearCount; i++) {
      const year = meta.sourceYearRange[0] + i;
      // Values are tenths of °F — convert to real degrees
      rawSeries.push({
        year,
        tmax: seriesEntry.tmax?.[i] != null ? seriesEntry.tmax[i] / 10 : NaN,
        tmin: seriesEntry.tmin?.[i] != null ? seriesEntry.tmin[i] / 10 : NaN,
        true_dtr: seriesEntry.true_dtr?.[i] != null ? seriesEntry.true_dtr[i] / 10 : NaN,
      });
    }

    // Extract all slopes from the meta entry.
    const tmaxSlope = (metaEntry as Record<string, unknown>)["tslopeFPerDecade_tmax"] as
      number | undefined;
    const tmeanSlope = (metaEntry as Record<string, unknown>)[
      "tslopeFPerDecade_tmean"
    ] as number | undefined;
    const tminSlope = (metaEntry as Record<string, unknown>)["tslopeFPerDecade_tmin"] as
      number | undefined;

    // True DTR slope from meta if available, otherwise compute from tmax/tmin slopes.
    const trueDtrSlope =
      typeof (metaEntry as Record<string, unknown>)["tslopeFPerDecade_true_dtr"] ===
      "number"
        ? ((metaEntry as Record<string, unknown>)["tslopeFPerDecade_true_dtr"] as number)
        : typeof tmaxSlope === "number" &&
            Number.isFinite(tmaxSlope) &&
            typeof tminSlope === "number" &&
            Number.isFinite(tminSlope)
          ? tmaxSlope - tminSlope
          : Number.NaN;

    const rawStdErrTmax = (metaEntry as Record<string, unknown>)["tslopeStdErr_tmax"];
    const rawStdErrTmin = (metaEntry as Record<string, unknown>)["tslopeStdErr_tmin"];
    const stdErrTmax = typeof rawStdErrTmax === "number" ? rawStdErrTmax : 0;
    const stdErrTmin = typeof rawStdErrTmin === "number" ? rawStdErrTmin : 0;

    // Compute true DTR standard error from propagated uncertainty
    let computedTrueDtrStdErr: number = Number.NaN;
    if (
      typeof tmaxSlope === "number" &&
      typeof tminSlope === "number" &&
      Number.isFinite(tmaxSlope) &&
      Number.isFinite(tminSlope)
    ) {
      computedTrueDtrStdErr = Math.sqrt(stdErrTmax ** 2 + stdErrTmin ** 2);
    }

    const trueDtrStdErr =
      typeof (metaEntry as Record<string, unknown>)["tslopeStdErr_true_dtr"] === "number"
        ? ((metaEntry as Record<string, unknown>)["tslopeStdErr_true_dtr"] as number)
        : computedTrueDtrStdErr;

    // Seasonal amplitude = slope(tmax) - slope(tmin)
    const seasonalAmpSlope =
      typeof tmaxSlope === "number" &&
      typeof tminSlope === "number" &&
      Number.isFinite(tmaxSlope) &&
      Number.isFinite(tminSlope)
        ? tmaxSlope - tminSlope
        : Number.NaN;

    counties.push({
      fips,
      name: metaEntry.name,
      state: metaEntry.state,
      series: rawSeries,
      slopeTMax: tmaxSlope ?? Number.NaN,
      slopeTMean: tmeanSlope ?? Number.NaN,
      slopeTMin: tminSlope ?? Number.NaN,
      slopeTrueDTR: trueDtrSlope ?? Number.NaN,
      slopeTrueDTRStdErr: trueDtrStdErr,
      slopeSeasonalAmplitude: seasonalAmpSlope,
    });
  }

  return {
    generatedAt: meta.generatedAt,
    sourceYearRange: meta.sourceYearRange,
    slopeDomains: meta.slopeDomains,
    counties,
  };
}

/** Fetch both split data files and return a merged CountyDataset. */
export async function loadCountyClimate(): Promise<CountyDataset> {
  const base = import.meta.env.BASE_URL; // "/" in dev, "/us-warming-map/" in CI
  const [metaRes, seriesRes] = await Promise.all([
    fetch(`${base}data/counties.meta.json`),
    fetch(`${base}data/counties.series.json`),
  ]);

  if (!metaRes.ok || !seriesRes.ok) {
    throw new Error("Failed to load climate data files. Did you run the pipeline?");
  }

  const meta = (await metaRes.json()) as MetaFile;
  const series = (await seriesRes.json()) as SeriesFile;

  return mergeMetaAndSeries(meta, series);
}

/** Load US TopoJSON county geometry and convert to GeoJSON.
 *
 * Strategy: Import the TopoJSON as a static module with `with { type: "json" }`,
 * then use topojson-client to convert it to a GeoJSON FeatureCollection.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- us-atlas is a well-known, immutable data source;
   topojson-client's types are stricter than us-atlas's actual TopoJSON structure. */
import { feature } from "topojson-client";

/** Static import of us-atlas TopoJSON. */
import countiesTopoJson from "us-atlas/counties-10m.json" with { type: "json" };

/** Return type matching choropleth.ts ChoroplethOptions.geometry. */
export type CountyGeometry = Record<string, unknown>;

/** Convert the statically imported TopoJSON to GeoJSON and return synchronously. */
export function loadCountyGeometry(): CountyGeometry {
  const topo = countiesTopoJson as any;
  return feature(topo, topo.objects.counties) as unknown as CountyGeometry;
}
