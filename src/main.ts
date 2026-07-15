// Entry point: load climate data + TopoJSON geometry, render choropleth map,
// and wire county hover/tap events to show the popup temperature chart.

import { loadCountyClimate, loadCountyGeometry, SlopeType } from "@/data/loadCountyData";
import { slopeColorScale } from "@/map/colorScale";
import { renderChoropleth, updateMapColors } from "@/map/choropleth";
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

  // Build the color scale using the precalculated tmean domain from the dataset.
  // The domain is [min, max] percentiles; we take the larger absolute value for symmetry.
  const tmeanDomain: [number, number] = dataset.slopeDomains?.tmean ?? [-0.05, 0.05];
  const colorScale = slopeColorScale(tmeanDomain);

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

  // Track the current slope type (default to tmean / average).
  let currentSlopeType: SlopeType = "tmean";

  // Create settings toggle button and panel, appending directly to body
  // so they remain visible above the SVG map layer.
  const toggleBtn = document.createElement("button");
  toggleBtn.id = "settings-toggle-btn";
  toggleBtn.textContent = "\u2699 Scales"; // gear icon
  toggleBtn.setAttribute("aria-label", "Toggle slope selector panel");
  document.body.appendChild(toggleBtn);

  // Create the slope selector panel.
  const panel = document.createElement("div");
  panel.className = "slope-selector-panel";
  panel.style.display = "none";
  panel.innerHTML = `
    <div class="slope-selector-title">Color by slope:</div>
    <div class="slope-option">
      <input type="radio" name="slope-type" id="slope-tmax" value="tmax">
      <label for="slope-tmax">Max Temp (Tmax)</label>
    </div>
    <div class="slope-option">
      <input type="radio" name="slope-type" id="slope-tmean" value="tmean" checked>
      <label for="slope-tmean">Avg Temp (Tmean)</label>
    </div>
    <div class="slope-option">
      <input type="radio" name="slope-type" id="slope-tmin" value="tmin">
      <label for="slope-tmin">Min Temp (Tmin)</label>
    </div>
  `;
  document.body.appendChild(panel);

  // Toggle panel visibility.
  let panelVisible = false;
  toggleBtn.addEventListener("click", () => {
    panelVisible = !panelVisible;
    panel.style.display = panelVisible ? "block" : "none";
  });

  // Wire radio button changes to update map colors.
  const updateSlopeType = (type: SlopeType) => {
    currentSlopeType = type;
    const svgEl = document.getElementById("choropleth-svg") as SVGSVGElement | null;
    if (svgEl) {
      updateMapColors(svgEl, type, dataset, slopeColorScale);
    }
  };

  panel.addEventListener("change", (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (target.name === "slope-type" && target.value) {
      updateSlopeType(target.value as SlopeType);
    }
  });

  // Render the choropleth.
  renderChoropleth({
    container: mapContainer,
    geometry: geojson,
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

  // Re-apply initial color on first render with default slope type.
  updateMapColors(
    document.getElementById("choropleth-svg") as unknown as SVGSVGElement,
    currentSlopeType,
    dataset,
    slopeColorScale,
  );

  console.log(`Rendered ${dataset.counties.length} counties.`);
}

// Run the app.
main().catch((err) => {
  console.error("Failed to initialize county warming map:", err);
});

export { main };
