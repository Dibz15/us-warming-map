// Entry point.
//
// Planned flow:
//   1. loadCountyGeometry()  -> src/data/loadCountyData.ts (TopoJSON -> GeoJSON)
//   2. loadCountyClimate()   -> src/data/loadCountyData.ts (precomputed per-county series + slope)
//   3. renderChoropleth()    -> src/map/choropleth.ts (colors counties by warming slope)
//   4. wire hover/tap events -> src/chart/popupChart.ts (renders the max/min/mean line chart)
//
// Intentionally left unimplemented — scaffolding only.

console.log("County Warming Trends — project scaffold. No dashboard yet.");
