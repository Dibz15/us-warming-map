// Entry point: load climate data + TopoJSON geometry, render choropleth map,
// and wire county hover/tap events to show the popup temperature chart.

import { loadCountyClimate, loadCountyGeometry } from "@/data/loadCountyData";
import { slopeColorScale } from "@/map/colorScale";
import { renderChoropleth } from "@/map/choropleth";
import { showPopupChart } from "@/chart/popupChart";
import type { CountyDataset } from "@/types";
import type { PopupPosition } from "@/chart/popupChart";

async function main(): Promise<void> {
  const mapContainer = document.getElementById("map-container") as HTMLElement;
  if (!mapContainer) {
    throw new Error("Expected #map-container element in index.html");
  }

  // Load both datasets in parallel (geometry is small; climate data ~3 MB).
  const [dataset, geojson] = await Promise.all([
    loadCountyClimate(),
    loadCountyGeometry(),
  ]);

  if (!geojson) {
    throw new Error("Failed to load TopoJSON geometry — aborting map render.");
  }

  // Build the color scale (use a domain of ±0.05 °F/decade; values outside are clamped).
  const colorScale = slopeColorScale(0.05);

  // Track the currently selected county so we can clear the popup.
  let selectedCounty: NonNullable<CountyDataset["counties"]>[number] | null = null;

  /** Position the popup chart to avoid viewport edges. */
  function computePosition(svgEl: SVGSVGElement, w: number, h: number): PopupPosition {
    const rect = svgEl.getBoundingClientRect();
    let x = rect.width / 2 - w / 2; // center by default
    let y = rect.height / 2 - h / 2;

    // Clamp to viewport edges.
    if (x < 4) x = 4;
    if (x + w > rect.width - 4) x = rect.width - w - 4;
    if (y < 4) y = 4;
    if (y + h > rect.height - 4) y = rect.height - h - 4;
    return { x, y };
  }

  // Render the choropleth.
  renderChoropleth({
    container: mapContainer,
    geometry: geojson as Record<string, unknown>,
    dataset,
    colorScale,
    onCountySelect(county) {
      const svgEl = document.getElementById("choropleth-svg") as SVGSVGElement | null;
      if (!svgEl) return;

      if (selectedCounty?.fips === county.fips) {
        // Click same county again → close popup.
        selectedCounty = null;
        document.querySelector<HTMLElement>(".popup-chart")?.remove();
        return;
      }

      selectedCounty = county;
      const position = computePosition(svgEl, 340, 300);
      showPopupChart({ container: mapContainer, county, position });
    },
  });

  console.log(`Rendered ${dataset.counties.length} counties.`);
}

// Run the app.
main().catch((err) => {
  console.error("Failed to initialize county warming map:", err);
});

export { main };
