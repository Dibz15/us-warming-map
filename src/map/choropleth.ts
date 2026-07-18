// Renders the US county choropleth (d3-geo + AlbersUSA projection),
// colored by src/map/colorScale.ts, with hover/tap handlers that hand off
// to src/chart/popupChart.ts.

// d3-transition must be imported to augment d3-selection's Selection interface
// with the `.transition()` method via TypeScript module augmentation.
import "d3-transition";

import { feature } from "topojson-client";
import { geoPath, geoAlbersUsa } from "d3-geo";
import { select } from "d3-selection";
import { zoom, zoomIdentity } from "d3-zoom";
import type { CountyDataset, MetricType, MethodType } from "@/types";
import { dtrColorScale, ampColorScale, slopeColorScale } from "./colorScale";

/** Lookup map from FIPS code to a numeric value (slope or period delta). */
export type ValueMap = Map<string, number>;

// Extend SVGSVGElement to hold our runtime context reference.
interface ExtendedSVGElement extends SVGSVGElement {
  __choroplethContext?: {
    countyDataMap: Map<string, NonNullable<CountyDataset["counties"]>[number]>;
    colorScale: ReturnType<typeof slopeColorScale>;
  };
}

export interface ChoroplethOptions {
  container: HTMLElement;
  /** TopoJSON or GeoJSON object containing county geometries. */
  geometry: Record<string, unknown>;
  /** The climate dataset with per-county slope data. */
  dataset: CountyDataset;
  /** Color scale function from colorScale.ts. */
  colorScale: ReturnType<typeof slopeColorScale>;
  /** Callback when a county is selected (click/tap). */
  onCountySelect?: (county: NonNullable<CountyDataset["counties"]>[number]) => void;
}

/** Feature type for TopoJSON-converted GeoJSON features. */
interface CountyFeature {
  geometry: unknown;
  id: string | number;
}

/** Render the choropleth map into the given container element. */
export function renderChoropleth(options: ChoroplethOptions): void {
  const { container, geometry, dataset, colorScale, onCountySelect } = options;

  // Clear any existing content
  select(container).selectAll("*").remove();

  // Create SVG container
  const svgEl = select(container)
    .append("svg")
    .attr("id", "choropleth-svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", "0 0 960 600")
    .attr("preserveAspectRatio", "xMidYMid meet")
    .node() as unknown as ExtendedSVGElement;

  const g = svgEl ? select(svgEl).append("g").attr("id", "counties-group") : null;
  if (!svgEl || !g) return;

  // Apply initial transform to center the map.
  g.attr("transform", "");

  // Add zoom/pan support for mobile and desktop.
  const zoomBehavior = zoom<SVGSVGElement, unknown>()
    .scaleExtent([1, 8])
    .on("zoom", (event: { transform: { toString: () => string } }) => {
      g.attr("transform", event.transform.toString());
    });

  select(svgEl).call(zoomBehavior);

  // Double-click to reset zoom.
  select(svgEl)
    .style("pointer-events", "all")
    .on("dblclick.zoom", (_event: MouseEvent) => {
      select<SVGSVGElement, unknown>(svgEl)
        .transition()
        .duration(750)
        .call(zoomBehavior.transform, zoomIdentity);
    });

  // Create projection and path generator
  const projection = geoAlbersUsa().scale(1100).translate([480, 300]);
  const pathGenerator = geoPath(projection);

  // Build a lookup map from FIPS to data
  const countyDataMap = new Map<string, NonNullable<CountyDataset["counties"]>[number]>();
  for (const county of dataset.counties) {
    countyDataMap.set(county.fips, county);
  }

  // State FIPS prefixes to exclude from rendering (Alaska, Hawaii).
  // These states have significant data gaps that distort the color scale.
  const EXCLUDED_STATE_PREFIXES = new Set(["02", "15"]);

  // Convert TopoJSON to GeoJSON features
  const geoFeatures: CountyFeature[] = [];

  if ("objects" in geometry && "type" in geometry && geometry.type === "Topology") {
    // It's a TopoJSON object with a `objects` property and `type: "Topology"`
    const topoObj = geometry as { objects: Record<string, { geometries: unknown[] }> };
    for (const [, obj] of Object.entries(topoObj.objects)) {
      if ("geometries" in obj) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = feature(geometry as any, obj as any) as unknown as {
          features: CountyFeature[];
        };
        for (const feat of raw.features) {
          const fips = String(feat.id ?? "").padStart(5, "0");
          // Skip excluded states (Alaska, Hawaii)
          if (EXCLUDED_STATE_PREFIXES.has(fips.slice(0, 2))) continue;
          geoFeatures.push(feat);
        }
      }
    }
  } else if ("features" in geometry) {
    // It's already a GeoJSON object
    const geoObj = geometry as {
      features: Array<{ geometry: unknown; id?: string | number }>;
    };
    for (const f of geoObj.features) {
      const fips = String(f.id ?? "").padStart(5, "0");
      // Skip excluded states (Alaska, Hawaii)
      if (EXCLUDED_STATE_PREFIXES.has(fips.slice(0, 2))) continue;
      geoFeatures.push({
        geometry: f.geometry,
        id: f.id ?? 0,
      });
    }
  }

  // Bind data and render paths — cast geometry to satisfy d3-geo's type checker.
  const counties = g
    .selectAll<SVGPathElement, CountyFeature>("path")
    .data(geoFeatures)
    .enter()
    .append("path")
    .attr("class", "county-path")
    .attr("d", (d) =>
      pathGenerator({ type: "Feature", geometry: d.geometry as never, properties: {} }),
    )
    .attr("fill", (d) => {
      const fips = String(d.id).padStart(5, "0");
      const county = countyDataMap.get(fips);
      if (!county) return "#ccc"; // Missing data
      return colorScale(county.slopeTMean);
    })
    .attr("stroke", "#fff")
    .attr("stroke-width", 0.5)
    .attr("tabindex", "0")
    .attr("role", "button")
    .attr("aria-label", (d) => {
      const fips = String(d.id).padStart(5, "0");
      const county = countyDataMap.get(fips);
      return county ? `${county.name} County, ${county.state}` : `County ${fips}`;
    })
    .style("cursor", "pointer")
    .style("outline", "none");

  // Hover effects
  counties
    .on(
      "mouseenter",
      function (this: SVGPathElement, _event: MouseEvent, _d: CountyFeature) {
        select(this).attr("stroke", "#333").attr("stroke-width", 1.5);
      },
    )
    .on(
      "mouseleave",
      function (this: SVGPathElement, _event: MouseEvent, _d: CountyFeature) {
        select(this).attr("stroke", "#fff").attr("stroke-width", 0.5);
      },
    )
    .on(
      "focus",
      function (this: SVGPathElement, _event: KeyboardEvent, _d: CountyFeature) {
        select(this).attr("stroke", "#333").attr("stroke-width", 1.5);
      },
    )
    .on(
      "blur",
      function (this: SVGPathElement, _event: KeyboardEvent, _d: CountyFeature) {
        select(this).attr("stroke", "#fff").attr("stroke-width", 0.5);
      },
    )
    // Click/tap handler — use both for mouse and keyboard accessibility
    .on("click", function (_event: MouseEvent, d: CountyFeature) {
      const fips = String(d.id).padStart(5, "0");
      if (fips && onCountySelect) {
        const county = countyDataMap.get(fips);
        if (county) {
          onCountySelect(county);
        }
      }
    })
    .on("keydown", function (event: KeyboardEvent, d: CountyFeature) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const fips = String(d.id).padStart(5, "0");
        if (fips && onCountySelect) {
          const county = countyDataMap.get(fips);
          if (county) {
            onCountySelect(county);
          }
        }
      }
    });

  // Store references on the SVG for later updates (e.g., re-coloring after popup closes)
  svgEl.__choroplethContext = { countyDataMap, colorScale };
}

/**
 * Update the fill color of all county paths in the choropleth SVG.
 *
 * When `method` is "trend", uses precomputed slopes from `dataset`.
 * When `method` is "period_delta", uses the provided `valueMap` instead.
 */
export function updateMapColors(
  svgEl: SVGSVGElement,
  options: {
    method: MethodType;
    metric: MetricType;
    dataset: CountyDataset;
    colorScaleFn: (domain: [number, number]) => (v: number) => string;
    valueMap?: ValueMap;
    domain: [number, number];
  },
): void {
  const { method, metric, valueMap, domain } = options;
  const svg = svgEl as unknown as ExtendedSVGElement;
  const context = svg.__choroplethContext;
  if (!context) return;

  // Choose the color function based on metric (for period delta we always use the diverging scale).
  const colorFn = computeColorFunction(metric, domain);

  // Update fill for each county path.
  select(svgEl)
    .selectAll<SVGPathElement, CountyFeature>(".county-path")
    .attr("fill", (d) => {
      const fips = String(d.id).padStart(5, "0");
      let value: number;

      if (method === "period_delta" && valueMap) {
        // Use the provided value map (e.g., period delta values).
        value = valueMap.get(fips) ?? NaN;
      } else {
        // Trend mode: use precomputed slopes from dataset.
        const county = context.countyDataMap.get(fips);
        if (!county) return "#ccc";

        // Map metric to the appropriate slope field.
        const value = getTrendValue(county, metric);
        if (value === undefined || Number.isNaN(value)) return "#ccc";
        return colorFn(value);
      }

      if (Number.isNaN(value)) return "#ccc";
      return colorFn(value);
    });
}

/**
 * Compute the appropriate color function for a given metric and domain.
 */
function computeColorFunction(
  metric: MetricType,
  domain: [number, number],
): (value: number) => string {
  // For metrics that use the standard blue-white-red diverging scale.
  if (["tmax", "tmean", "tmin"].includes(metric)) {
    return slopeColorScale(domain);
  }

  // Use purple-white-green for DTR and seasonal amplitude (matching pipeline palette).
  if (metric === "true_dtr") {
    return dtrColorScale(domain);
  }

  // Seasonal amplitude also uses the same diverging scale.
  return ampColorScale(domain);
}

/**
 * Get the trend value for a county given a metric type.
 */
function getTrendValue(
  county: NonNullable<CountyDataset["counties"]>[number],
  metric: MetricType,
): number | undefined {
  switch (metric) {
    case "tmax":
      return county.slopeTMax;
    case "tmean":
      return county.slopeTMean;
    case "tmin":
      return county.slopeTMin;
    case "true_dtr":
      return county.slopeTrueDTR;
    case "seasonal_amplitude":
      return county.slopeSeasonalAmplitude;
  }
}
