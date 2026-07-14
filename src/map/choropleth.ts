// Renders the US county choropleth (d3-geo + AlbersUSA projection),
// colored by src/map/colorScale.ts, with hover/tap handlers that hand off
// to src/chart/popupChart.ts.

import { feature } from "topojson-client";
import { geoPath, geoAlbersUsa } from "d3-geo";
import { select } from "d3-selection";
import type { CountyDataset } from "@/types";
import type { slopeColorScale } from "./colorScale";

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
  const svg = select(container)
    .append("svg")
    .attr("id", "choropleth-svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", "0 0 960 600")
    .attr("preserveAspectRatio", "xMidYMid meet")
    .node() as unknown as ExtendedSVGElement;

  const g = svg ? select(svg).append("g").attr("id", "counties-group") : null;
  if (!svg || !g) return;

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
      return colorScale(county.slopeFPerDecade);
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
  svg.__choroplethContext = { countyDataMap, colorScale };
}
