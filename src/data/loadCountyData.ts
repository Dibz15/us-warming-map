// Loads two things at startup:
//   - County boundary TopoJSON (from the `us-atlas` package, copied/imported
//     as a static asset — see README "Data pipeline" section)
//   - The precomputed climate dataset (public/data/counties.json), produced
//     by data-pipeline/process_to_dataset.py from NOAA NCEI county data
//
// Not implemented yet — scaffolding only.

import type { CountyDataset } from "@/types";

export async function loadCountyClimate(): Promise<CountyDataset> {
  throw new Error("not implemented");
}

export async function loadCountyGeometry(): Promise<unknown> {
  throw new Error("not implemented");
}
