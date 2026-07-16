// Entry point: load climate data + TopoJSON geometry, render choropleth map,
// and wire county hover/tap events to show the popup temperature chart.

import { loadCountyClimate, loadCountyGeometry, SlopeType } from "@/data/loadCountyData";
import { slopeColorScale, dtrColorScale } from "@/map/colorScale";
import { renderChoropleth, updateMapColors } from "@/map/choropleth";
import { showPopupChart } from "@/chart/popupChart";
import type { CountyDataset } from "@/types";
import type { PopupPosition } from "@/chart/popupChart";

/** Labels specific to each two-channel slope type. */
const SLOPE_TYPE_LABELS: Record<
  "true_dtr" | "seasonal_amplitude",
  { xTop: string; xBottom: string }
> = {
  true_dtr: {
    xTop: "Nights Leading (DTR ↓)",
    xBottom: "Days Leading (DTR ↑)",
  },
  seasonal_amplitude: {
    xTop: "Narrowing Amplitude",
    xBottom: "Widening Amplitude",
  },
};

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
        <div class="slope-option">
          <input type="radio" name="slope-type" id="slope-true_dtr" value="true_dtr">
          <label for="slope-true_dtr">True Diurnal Temp Range (DTR)</label>
        </div>
        <div class="slope-option">
          <input type="radio" name="slope-type" id="slope-seasonal_amp" value="seasonal_amplitude">
          <label for="slope-seasonal_amp">Seasonal Amplitude</label>
        </div>
   `;
  document.body.appendChild(panel);

  // --- Create the two grid-based legend cards (DTR & Seasonal Amplitude) ---
  const dtrLegend = createGridLegend("dtr-legend", "True Diurnal Temperature Range");
  const seasonalAmpLegend = createGridLegend(
    "seasonal-amp-legend",
    "Seasonal Amplitude Change",
  );
  document.body.appendChild(dtrLegend);
  document.body.appendChild(seasonalAmpLegend);

  // --- Toggle panel visibility. ---
  let panelVisible = false;
  toggleBtn.addEventListener("click", () => {
    panelVisible = !panelVisible;
    panel.style.display = panelVisible ? "block" : "none";
  });

  // --- Wire radio button changes to update map colors and legends. ---
  const updateSlopeType = (type: SlopeType) => {
    currentSlopeType = type;
    const svgEl = document.getElementById("choropleth-svg") as SVGSVGElement | null;
    if (svgEl) {
      updateMapColors(svgEl, type, dataset, slopeColorScale);
    }

    // Hide both legends by default.
    dtrLegend.style.display = "none";
    seasonalAmpLegend.style.display = "none";

    // Show the appropriate 2D grid legend for two-channel types.
    if (type === "true_dtr") {
      dtrLegend.style.display = "block";
      populateGridLegend(dtrLegend, dataset, "true_dtr");
    } else if (type === "seasonal_amplitude") {
      seasonalAmpLegend.style.display = "block";
      populateGridLegend(seasonalAmpLegend, dataset, "seasonal_amplitude");
    }
  };

  /**
   * Create a minimal grid-legend DOM structure.
   */
  function createGridLegend(id: string, title: string): HTMLElement {
    const el = document.createElement("div");
    el.id = id;
    el.className = "grid-legend";
    el.style.display = "none";
    el.innerHTML = `
      <div class="grid-legend-title">${title}</div>
      <div class="grid-legend-wrapper">
        <span class="grid-legend-x-label-top"></span>
        <span class="grid-legend-y-label-left"></span>
        <div class="grid-swatches"></div>
        <span class="grid-legend-y-label-right"></span>
        <span class="grid-legend-x-label-bottom"></span>
        <span class="grid-legend-footnote">
          <span class="grid-legend-swatch-gray"></span> Not statistically significant (|DTR| < 2× SE)
        </span>
      </div>
    `;
    return el;
  }

  /**
   * Generic 2D grid legend populator.
   * Fills the swatches, Y-axis labels, and X-axis labels based on the given slope type.
   */
  function populateGridLegend(
    legendEl: HTMLElement,
    data: CountyDataset,
    slopeType: "true_dtr" | "seasonal_amplitude",
  ): void {
    const domain = data.slopeDomains[slopeType] ?? [-5, 5];
    const colorFn = dtrColorScale(domain);

    const labels = SLOPE_TYPE_LABELS[slopeType];
    const swatchesContainer = legendEl.querySelector<HTMLDivElement>(".grid-swatches");
    if (!swatchesContainer) return;

    // Clear any previous swatches.
    swatchesContainer.innerHTML = "";

    // Axis labels.
    const xTop = legendEl.querySelector<HTMLElement>(".grid-legend-x-label-top");
    const xBottom = legendEl.querySelector<HTMLElement>(".grid-legend-x-label-bottom");
    if (xTop) xTop.textContent = labels.xTop;
    if (xBottom) xBottom.textContent = labels.xBottom;

    // Y-axis labels: "Low Magnitude" (top) ↔ "High Magnitude" (bottom).
    const yLeft = legendEl.querySelector<HTMLElement>(".grid-legend-y-label-left");
    const yRight = legendEl.querySelector<HTMLElement>(".grid-legend-y-label-right");
    if (yLeft) yLeft.textContent = "Low";
    if (yRight) yRight.textContent = "High";

    // Compute the larger absolute extent for scaling.
    const dtrMin = domain[0];
    const dtrMax = domain[1];
    const dtrExtent = Math.max(Math.abs(dtrMin), Math.abs(dtrMax));

    // Magnitude levels (rows): top=high (1.0), middle=mid (0.67), bottom=low (0.33).
    const magnitudeLevelsRowFactor = [1, 0.67, 0.33];

    for (let row = 0; row < 3; row++) {
      const magLevel = magnitudeLevelsRowFactor[row];
      for (let col = 0; col < 7; col++) {
        // Hue level: -1 (left) → +1 (right).
        const hueLevel = (col / 6) * 2 - 1;

        // Map hue level to the actual domain extent.
        const dtrSlope = hueLevel * dtrExtent;
        // Magnitude is always a positive factor of the domain extent.
        const dtrMag = magLevel * dtrExtent;

        // Use a tiny fake standard error so the color scale treats it as "significant".
        const fakeStdErr = Math.abs(dtrSlope) * 0.01;
        const color = colorFn(dtrSlope, dtrMag, fakeStdErr);

        const swatch = document.createElement("div");
        swatch.style.width = "16px";
        swatch.style.height = "12px";
        swatch.style.backgroundColor = color;
        swatch.style.border = "1px solid rgba(0,0,0,0.08)";
        swatch.style.borderRadius = "1px";
        swatchesContainer.appendChild(swatch);
      }
    }
  }

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
