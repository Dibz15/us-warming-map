// Entry point: load climate data + TopoJSON geometry, render choropleth map,
// and wire county hover/tap events to show the popup temperature chart.

import { loadCountyClimate, loadCountyGeometry, SlopeType } from "@/data/loadCountyData";
import { slopeColorScale, dtrColorScale, ampColorScale } from "@/map/colorScale";
import { renderChoropleth, updateMapColors } from "@/map/choropleth";
import { showPopupChart } from "@/chart/popupChart";
import type { CountyDataset, MetricType, MethodType, YearWindow } from "@/types";
import type { PopupPosition, PopupUpdater } from "@/chart/popupChart";

export type { SlopeType } from "@/data/loadCountyData";

/** Labels for DTR interpretation in legends. */
const DTR_INTERPRETATION =
  "Positive: Daytime warming faster than nighttime<br>Negative: Nighttime warming faster than daytime";

/** Labels for Seasonal Amplitude interpretation in legends. */
const AMP_INTERPRETATION =
  "Positive: Summer warming faster than winter<br>Negative: Winter warming faster than summer";

/** Labels for temperature slope interpretation in legends. */
const TEMP_SLOPE_INTERPRETATION = "Positive: Warming trend<br>Negative: Cooling trend";
const TMAX_SLOPE_INTERPRETATION =
  "Positive: Warming summers<br>Negative: Cooling summers<br>Note: Some areas show summer cooling. Even so, mean<br>max temperature is increasing everywhere despite<br>summer cooling, due to increased winter warming.";
const TMIN_SLOPE_INTERPRETATION =
  "Positive: Warming winters<br>Negative: Cooling winters";

/** Metric display labels. */
const METRIC_LABELS: Record<MetricType, string> = {
  tmax: "Max Temp",
  tmean: "Mean Temp",
  tmin: "Min Temp",
  true_dtr: "DTR",
  seasonal_amplitude: "Seasonal Amp",
};

/** Units for the current method. */
const METHOD_UNITS: Record<MethodType, string> = {
  trend: "\u00b0F/decade",
  period_delta: "\u00b0F",
};

/** Minimum gap between baseline and recent windows (years). */
const MIN_WINDOW_GAP = 20;

/** Default number of years in each window when period delta is first activated. */
const DEFAULT_WINDOW_YEARS = 15;

interface PeriodDeltaState {
  baseline: YearWindow;
  recent: YearWindow;
}

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
  const tmeanDomain: [number, number] = dataset.slopeDomains?.tmean ?? [-0.05, 0.05];
  const colorScale = slopeColorScale(tmeanDomain);

  // Track the currently selected county so we can clear the popup.
  let selectedCounty: NonNullable<CountyDataset["counties"]>[number] | null = null;

  /** Position the popup chart to center it on the map viewport. */
  function computePosition(svgEl: SVGSVGElement, w: number, h: number): PopupPosition {
    const rect = svgEl.getBoundingClientRect();
    let x = rect.width / 2 - w / 2;
    let y = rect.height / 2 - h / 2;
    if (x < 8) x = 8;
    if (x + w > rect.width - 8) x = rect.width - w - 8;
    if (y < 8) y = 8;
    if (y + h > rect.height - 8) y = rect.height - h - 8;
    return { x, y };
  }

  // --- State tracking ---
  let currentMetric: MetricType = "tmean";
  let currentMethod: MethodType = "trend";
  let periodDeltaState: PeriodDeltaState | null = null;
  let currentDomain: [number, number] = tmeanDomain;

  /** Track the active popup chart updater for dynamic timeline updates. */
  let currentPopupUpdater: PopupUpdater | null = null;

  // --- Settings toggle button and panel ---
  const toggleBtn = document.createElement("button");
  toggleBtn.id = "settings-toggle-btn";
  toggleBtn.textContent = "\u2699 Scales";
  toggleBtn.setAttribute("aria-label", "Toggle slope selector panel");
  document.body.appendChild(toggleBtn);

  // Create the settings panel.
  const panel = document.createElement("div");
  panel.className = "slope-selector-panel";
  panel.style.display = "none";
  document.body.appendChild(panel);

  /** Rebuild the entire panel content based on current method/metric state. */
  function rebuildPanel(): void {
    const isPeriodDelta = currentMethod === "period_delta";
    let html = `
      <div class="pd-section">
        <div class="slope-selector-title">Method:</div>
        <div class="slope-option">
          <input type="radio" name="method-type" id="method-trend" value="trend" ${!isPeriodDelta ? "checked" : ""}>
          <label for="method-trend">Trend (OLS slope)</label>
        </div>
        <div class="slope-option">
          <input type="radio" name="method-type" id="method-period-delta" value="period_delta" ${isPeriodDelta ? "checked" : ""}>
          <label for="method-period-delta">Period Delta</label>
        </div>
      </div>
      <div class="pd-section">
        <div class="slope-selector-title">Metric:</div>`;

    // List all metrics, disabling DTR when in period delta mode.
    const metrics: MetricType[] = [
      "tmax",
      "tmean",
      "tmin",
      "true_dtr",
      "seasonal_amplitude",
    ];
    for (const m of metrics) {
      const disabled = isPeriodDelta && m === "true_dtr";
      const checked = currentMetric === m ? "checked" : "";
      const disabledAttr = disabled ? 'disabled style="opacity:0.5"' : "";
      html += `
        <div class="slope-option ${disabled ? "disabled-metric" : ""}">
          <input type="radio" name="metric-type" id="metric-${m}" value="${m}" ${checked} ${disabledAttr}>
          <label for="metric-${m}">${METRIC_LABELS[m]}</label>
          ${disabled ? '<span class="metric-tooltip" title="Requires per-year mean Tmax/Tmin data not yet available in the pipeline"> \u2139\uFE0F</span>' : ""}
        </div>`;
    }

    html += `</div>`;

    // Year range picker (period delta only) — dual-handle timeline slider.
    if (isPeriodDelta && periodDeltaState) {
      const allYears = dataset.sourceYearRange;
      const bStart = periodDeltaState.baseline.start;
      const bEnd = periodDeltaState.baseline.end;
      const rStart = periodDeltaState.recent.start;
      const rEnd = periodDeltaState.recent.end;
      html += `
        <div class="pd-section pd-year-picker" style="display:block">
          <div class="slope-selector-title">Year Ranges:</div>
          <div class="pd-timeline-labels">
            <span id="pd-baseline-label">${bStart} \u2013 ${bEnd}</span>
            <span id="pd-recent-label">${rStart} \u2013 ${rEnd}</span>
          </div>
          <div class="pd-timeline-container" id="pd-timeline-container">
            <div class="pd-timeline-track" id="pd-timeline-track">
              <!-- Visual markers for the two windows -->
              <div id="pd-baseline-range" class="pd-timeline-range pd-baseline-range"></div>
              <div id="pd-recent-range" class="pd-timeline-range pd-recent-range"></div>
              <!-- Draggable handles -->
              <div id="pd-baseline-center-handle" class="pd-timeline-handle pd-baseline-handle" style="left:${(((bStart + bEnd) / 2 - allYears[0]) / (allYears[1] - allYears[0])) * 100}%;"></div>
              <div id="pd-recent-center-handle" class="pd-timeline-handle pd-recent-handle" style="left:${(((rStart + rEnd) / 2 - allYears[0]) / (allYears[1] - allYears[0])) * 100}%;"></div>
            </div>
          </div>
        </div>`;
    }

    panel.innerHTML = html;
    panel.style.display = isPeriodDelta || true ? "block" : "none";

    // --- Attach pointer handlers for timeline dragging on the container ---
    const tlContainer = document.getElementById("pd-timeline-container");
    if (tlContainer && periodDeltaState) {
      tlContainer.addEventListener(
        "pointerdown",
        (evt: PointerEvent) => {
          if (!(evt.target instanceof HTMLElement)) return;
          // Check if the target or its parent is a timeline handle.
          const handle = evt.target.closest(".pd-timeline-handle");
          if (!handle || !(handle instanceof HTMLElement)) return;
          if (!handle.id) return;
          const isBaseline = handle.id === "pd-baseline-center-handle";
          const target: "baseline" | "recent" = isBaseline ? "baseline" : "recent";
          // Only grab pointer for timeline interaction.
          (evt.currentTarget as HTMLElement).setPointerCapture(evt.pointerId);
          evt.preventDefault();
          setupTimelineDragging(target);
        },
        { passive: false },
      );
    }

    // Handle panel change events (radio button selection).
    const handlePanelChange = (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (!target.name) return;

      if (target.name === "method-type" && target.value) {
        const newMethod = target.value as MethodType;
        const wasPeriodDelta = currentMethod === "period_delta";
        currentMethod = newMethod;

        // Initialize period delta state on first activation.
        if (newMethod === "period_delta" && !periodDeltaState) {
          initPeriodDeltaWindows();
        }

        // If deactivating period delta, clear state.
        if (wasPeriodDelta && newMethod !== "period_delta") {
          periodDeltaState = null;
        }

        // Rebuild the panel to reflect new method state (DTR disabled/visible year picker).
        rebuildPanel();
        applyMetricAndMethod();
      }

      if (target.name === "metric-type" && target.value) {
        currentMetric = target.value as MetricType;
        applyMetricAndMethod();
      }
    };

    // Wire up method radio buttons.
    panel.addEventListener("change", handlePanelChange);
  }

  /** Initialize default year windows based on the dataset's record. */
  function initPeriodDeltaWindows(): void {
    const [yStart, yEnd] = dataset.sourceYearRange;
    const totalYears = yEnd - yStart + 1;
    const winSize = Math.min(DEFAULT_WINDOW_YEARS, Math.floor(totalYears / 4));

    periodDeltaState = {
      baseline: { start: yStart, end: yStart + winSize - 1 },
      recent: { start: yEnd - winSize + 1, end: yEnd },
    };
  }

  // --- Timeline dragging state ---
  let dragTarget: "baseline" | "recent" | null = null;

  /** Set up pointer-based dragging on the timeline handles. */
  function setupTimelineDragging(target: "baseline" | "recent"): void {
    const timelineContainer = document.getElementById("pd-timeline-container");
    if (!timelineContainer) return;

    dragTarget = target;

    // Attach to the track so movement outside the handle still works.
    let trackEl: HTMLElement = document.getElementById("pd-timeline-track")!;

    if (trackEl) {
      trackEl.style.cursor = "grabbing";
    }

    function onPointerMove(moveEvt: PointerEvent): void {
      moveEvt.preventDefault();
      if (trackEl) {
        const rect = trackEl.getBoundingClientRect();
        // Clamp to track boundaries.
        const pct = Math.max(0, Math.min(1, (moveEvt.clientX - rect.left) / rect.width));
        updateTimelineFromPct(pct);
      }
    }

    function onPointerUp(): void {
      dragTarget = null;
      if (trackEl) trackEl.style.cursor = "grab";
      timelineContainer!.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    }

    // Capture pointer from the pointerdown that triggered this call.
    // The actual event is captured by the pointerdown handler that calls this function.
    timelineContainer!.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  }

  /** Compute window positions from a 0-1 percentage along the timeline. */
  function updateTimelineFromPct(pct: number): void {
    if (!periodDeltaState) return;
    const allYears = dataset.sourceYearRange;
    const yMin = allYears[0];
    const yMax = allYears[1];
    const totalSpan = yMax - yMin + 1;
    const winSize = periodDeltaState.baseline.end - periodDeltaState.baseline.start;
    const halfWin = Math.floor(winSize / 2);

    if (dragTarget === "baseline" && periodDeltaState) {
      const centeredYear = Math.round(yMin + pct * totalSpan);
      // Constrain baseline center so it stays at least winSize/2 from edges
      // and at least MIN_WINDOW_GAP before the recent window.
      const maxBCenter = periodDeltaState.recent.start - MIN_WINDOW_GAP - 1;
      const minBCenter = yMin + halfWin;
      const bCenter = clampYear(centeredYear, minBCenter, maxBCenter);
      periodDeltaState.baseline = { start: bCenter - halfWin, end: bCenter + halfWin };
    }

    if (dragTarget === "recent" && periodDeltaState) {
      const centeredYear = Math.round(yMin + pct * totalSpan);
      // Constrain recent center so it stays at least winSize/2 from edges
      // and at least MIN_WINDOW_GAP after the baseline window.
      const minRCenter = periodDeltaState.baseline.end + MIN_WINDOW_GAP + halfWin;
      const maxRCenter = yMax - halfWin;
      const rCenter = clampYear(centeredYear, minRCenter, maxRCenter);
      periodDeltaState.recent = { start: rCenter - halfWin, end: rCenter + halfWin };
    }

    updateTimelineUI();
  }

  function clampYear(val: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, val));
  }

  /** Update the timeline UI (handles + labels) without recomputing data. */
  function updateTimelineUI(): void {
    if (!periodDeltaState) return;
    const allYears = dataset.sourceYearRange;
    const winSize = periodDeltaState.baseline.end - periodDeltaState.baseline.start;

    // Update handles position.
    const bHandle = document.getElementById("pd-baseline-center-handle");
    const rHandle = document.getElementById("pd-recent-center-handle");
    if (bHandle) {
      const bCenter =
        (periodDeltaState.baseline.start + periodDeltaState.baseline.end) / 2;
      const pct = ((bCenter - allYears[0]) / (allYears[1] - allYears[0])) * 100;
      bHandle.style.left = `${pct}%`;
    }
    if (rHandle) {
      const rCenter = (periodDeltaState.recent.start + periodDeltaState.recent.end) / 2;
      const pct = ((rCenter - allYears[0]) / (allYears[1] - allYears[0])) * 100;
      rHandle.style.left = `${pct}%`;
    }

    // Update window range indicators.
    const bRange = document.getElementById("pd-baseline-range");
    const rRange = document.getElementById("pd-recent-range");
    if (bRange) {
      const bLeft =
        ((periodDeltaState.baseline.start - allYears[0]) / (allYears[1] - allYears[0])) *
        100;
      const bWidth = (winSize / (allYears[1] - allYears[0])) * 100;
      bRange.style.left = `${bLeft}%`;
      bRange.style.width = `${bWidth}%`;
    }
    if (rRange) {
      const rLeft =
        ((periodDeltaState.recent.start - allYears[0]) / (allYears[1] - allYears[0])) *
        100;
      const rWidth = (winSize / (allYears[1] - allYears[0])) * 100;
      rRange.style.left = `${rLeft}%`;
      rRange.style.width = `${rWidth}%`;
    }

    // Update label text.
    const bLabel = document.getElementById("pd-baseline-label");
    const rLabel = document.getElementById("pd-recent-label");
    if (bLabel) {
      bLabel.textContent = `${periodDeltaState.baseline.start} \u2013 ${periodDeltaState.baseline.end}`;
    }
    if (rLabel) {
      rLabel.textContent = `${periodDeltaState.recent.start} \u2013 ${periodDeltaState.recent.end}`;
    }

    computeAndApplyPeriodDelta();

    // Update the active popup chart's window indicators and delta text.
    if (currentPopupUpdater && periodDeltaState) {
      currentPopupUpdater.update({
        baseline: periodDeltaState.baseline,
        recent: periodDeltaState.recent,
      });
    }
  }

  /** Recolor the map and update legends based on current method/metric/window state. */
  function applyMetricAndMethod(): void {
    const svgEl = document.getElementById("choropleth-svg") as SVGSVGElement | null;
    if (!svgEl) return;

    // Hide all legends by default.
    dtrLegend.style.display = "none";
    seasonalAmpLegend.style.display = "none";
    tmaxLegend.style.display = "none";
    tmeanLegend.style.display = "none";
    tminLegend.style.display = "none";

    if (currentMethod === "trend") {
      // Map metric to slope type for popup chart.
      currentDomain = dataset.slopeDomains[currentMetric] ?? [-1, 1];

      updateMapColors(svgEl, {
        method: currentMethod,
        metric: currentMetric,
        dataset,
        colorScaleFn: slopeColorScale,
        domain: currentDomain,
      });

      // Show the appropriate legend.
      showLegendForMetric(currentMetric);
    } else {
      // Period delta mode.
      if (!periodDeltaState) return;
      computeAndApplyPeriodDelta();
    }

    updateLegendUnits();
  }

  /** Show the legend corresponding to a metric in trend mode. */
  function showLegendForMetric(metric: MetricType): void {
    let legendEl: HTMLElement | null;
    let domain: [number, number];
    let scaleFn: (d: [number, number]) => (v: number) => string;

    switch (metric) {
      case "true_dtr":
        legendEl = dtrLegend;
        domain = dataset.slopeDomains["true_dtr"] ?? [-1, 1];
        scaleFn = dtrColorScale;
        break;
      case "seasonal_amplitude":
        legendEl = seasonalAmpLegend;
        domain = dataset.slopeDomains["seasonal_amplitude"] ?? [-1, 1];
        scaleFn = ampColorScale;
        break;
      case "tmax":
        legendEl = tmaxLegend;
        domain = dataset.slopeDomains["tmax"] ?? [-1, 1];
        scaleFn = slopeColorScale;
        break;
      case "tmin":
        legendEl = tminLegend;
        domain = dataset.slopeDomains["tmin"] ?? [-1, 1];
        scaleFn = slopeColorScale;
        break;
      default:
        legendEl = tmeanLegend;
        domain = dataset.slopeDomains["tmean"] ?? [-1, 1];
        scaleFn = slopeColorScale;
    }

    if (legendEl) {
      legendEl.style.display = "block";
      populateLinearLegend(legendEl, domain, scaleFn);
    }
  }

  /** Compute period deltas for all counties and apply to the map. */
  function computeAndApplyPeriodDelta(): void {
    if (!periodDeltaState) return;

    const { baseline, recent } = periodDeltaState;
    const valueMap = new Map<string, number>();
    let hasData = false;

    for (const county of dataset.counties) {
      const series = county.series;
      if (!series || series.length === 0) continue;

      // Build a lookup from year to metric value.
      const yearToValue = new Map<number, number>();
      for (const record of series) {
        let val: number;
        switch (currentMetric) {
          case "tmax":
            val = record.tmax;
            break;
          case "tmin":
            val = record.tmin;
            break;
          case "tmean":
            val = (record.tmax + record.tmin) / 2;
            break;
          case "true_dtr":
            val = record.true_dtr;
            break;
          case "seasonal_amplitude":
            val = record.tmax - record.tmin;
            break;
          default:
            val = NaN;
        }
        yearToValue.set(record.year, val);
      }

      // Compute mean for each window.
      const baselineMean = windowMean(yearToValue, baseline.start, baseline.end);
      const recentMean = windowMean(yearToValue, recent.start, recent.end);

      if (Number.isFinite(baselineMean) && Number.isFinite(recentMean)) {
        const delta = recentMean - baselineMean;
        valueMap.set(county.fips, delta);
        hasData = true;
      }
    }

    if (!hasData) return;

    // Compute symmetric domain from percentiles.
    const allValues = Array.from(valueMap.values());
    const [p1, p99] = computePercentiles(allValues, [1, 99]);
    const absMin = Math.abs(p1);
    const absMax = Math.abs(p99);
    const extent = Math.max(absMin, absMax);

    if (extent <= 0) {
      currentDomain = [-1, 1];
    } else {
      currentDomain = [-extent, extent];
    }

    const svgEl = document.getElementById("choropleth-svg") as SVGSVGElement | null;
    if (!svgEl) return;

    updateMapColors(svgEl, {
      method: "period_delta",
      metric: currentMetric,
      dataset,
      colorScaleFn: slopeColorScale,
      valueMap,
      domain: currentDomain,
    });

    // Update legend for period delta.
    updatePeriodDeltaLegend();
  }

  /** Compute the mean of values in [wStart, wEnd] inclusive from a year->value map. */
  function windowMean(
    yearToValue: Map<number, number>,
    wStart: number,
    wEnd: number,
  ): number {
    let sum = 0;
    let count = 0;
    for (let y = wStart; y <= wEnd; y++) {
      const v = yearToValue.get(y);
      if (v != null && Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    return count > 0 ? sum / count : NaN;
  }

  /** Compute percentiles for an array of numbers. */
  function computePercentiles(values: number[], percentiles: number[]): [number, number] {
    const sorted = values.slice().sort((a, b) => a - b);
    const result: number[] = [];
    for (const p of percentiles) {
      const idx = Math.ceil((p / 100) * sorted.length) - 1;
      result.push(sorted[Math.max(0, idx)]);
    }
    return [result[0], result[1]] as [number, number];
  }

  /** Update legend unit labels based on the active method. */
  function updateLegendUnits(): void {
    const units = METHOD_UNITS[currentMethod];
    // Update all linear legend subtitled unit labels.
    document.querySelectorAll(".linear-legend-subtitle").forEach((el) => {
      (el as HTMLElement).textContent = units;
    });
  }

  // --- Legend elements ---
  const dtrLegend = createLinearLegend(
    "dtr-legend",
    "True Diurnal Temperature Range",
    DTR_INTERPRETATION,
  );
  const seasonalAmpLegend = createLinearLegend(
    "seasonal-amp-legend",
    "Seasonal Amplitude Change",
    AMP_INTERPRETATION,
  );
  const tmaxLegend = createLinearLegend(
    "tmax-legend",
    "Max Temperature (Tmax) Slope",
    TMAX_SLOPE_INTERPRETATION,
  );
  const tmeanLegend = createLinearLegend(
    "tmean-legend",
    "Mean Temperature (Tmean) Slope",
    TEMP_SLOPE_INTERPRETATION,
  );
  const tminLegend = createLinearLegend(
    "tmin-legend",
    "Min Temperature (Tmin) Slope",
    TMIN_SLOPE_INTERPRETATION,
  );
  document.body.appendChild(dtrLegend);
  document.body.appendChild(seasonalAmpLegend);
  document.body.appendChild(tmaxLegend);
  document.body.appendChild(tmeanLegend);
  document.body.appendChild(tminLegend);

  /**
   * Create a linear gradient legend DOM structure.
   */
  function createLinearLegend(
    id: string,
    title: string,
    interpretation: string,
  ): HTMLElement {
    const el = document.createElement("div");
    el.id = id;
    el.className = "linear-legend";
    el.style.display = "none";
    el.innerHTML = `
      <div class="linear-legend-title">${title}</div>
      <div class="linear-legend-subtitle" style="font-size:0.8em;color:#666;margin-bottom:4px;"></div>
      <div class="linear-legend-gradient"></div>
      <div class="linear-legend-labels">
        <span class="linear-legend-left"></span>
        <span class="linear-legend-center">0</span>
        <span class="linear-legend-right"></span>
      </div>
      <div class="linear-legend-interpretation">${interpretation}</div>
    `;
    return el;
  }

  /**
   * Populate a linear gradient legend with domain-specific values.
   */
  function populateLinearLegend(
    legendEl: HTMLElement,
    domain: [number, number],
    colorScaleFn: (domain: [number, number]) => (value: number) => string,
  ): void {
    const [min, max] = domain;
    const gradientContainer = legendEl.querySelector<HTMLDivElement>(
      ".linear-legend-gradient",
    );
    const leftLabel = legendEl.querySelector<HTMLElement>(".linear-legend-left");
    const rightLabel = legendEl.querySelector<HTMLElement>(".linear-legend-right");

    if (!gradientContainer || !leftLabel || !rightLabel) return;

    leftLabel.textContent = min.toFixed(4);
    rightLabel.textContent = max.toFixed(4);

    const stepsPerSide = 10;
    const fragment = document.createDocumentFragment();

    // Left side: min → 0 (negative values)
    for (let i = 0; i < stepsPerSide; i++) {
      const t = i / (stepsPerSide - 1);
      const value = min + t * (0 - min);
      const color = colorScaleFn(domain)(value);

      const swatch = document.createElement("div");
      swatch.className = "linear-legend-swatch";
      swatch.style.width = `${50 / stepsPerSide}%`;
      swatch.style.backgroundColor = color;
      fragment.appendChild(swatch);
    }

    // Right side: 0 → max (positive values)
    for (let i = 0; i < stepsPerSide; i++) {
      const t = i / (stepsPerSide - 1);
      const value = 0 + t * (max - 0);
      const color = colorScaleFn(domain)(value);

      const swatch = document.createElement("div");
      swatch.className = "linear-legend-swatch";
      swatch.style.width = `${50 / stepsPerSide}%`;
      swatch.style.backgroundColor = color;
      fragment.appendChild(swatch);
    }

    gradientContainer.innerHTML = "";
    gradientContainer.appendChild(fragment);
  }

  /** Update the period delta legend with current metric label + units. */
  function updatePeriodDeltaLegend(): void {
    // Determine which legend to reuse (the one matching the palette).
    let activeLegend: HTMLElement;
    let scaleFn: (d: [number, number]) => (v: number) => string;

    if (currentMetric === "true_dtr") {
      activeLegend = dtrLegend;
      scaleFn = dtrColorScale;
    } else if (currentMetric === "seasonal_amplitude") {
      activeLegend = seasonalAmpLegend;
      scaleFn = ampColorScale;
    } else {
      activeLegend = tmeanLegend;
      scaleFn = slopeColorScale;
    }

    // Update the title and subtitle to reflect period delta + metric.
    const titleEl = activeLegend.querySelector<HTMLElement>(".linear-legend-title");
    if (titleEl) {
      titleEl.textContent = `${METRIC_LABELS[currentMetric]} — Period Delta`;
    }

    // Show the legend (it's hidden by default in applyMetricAndMethod).
    activeLegend.style.display = "block";

    populateLinearLegend(activeLegend, currentDomain, scaleFn);
    updateLegendUnits();
  }

  panel.style.display = "none";

  // --- Toggle panel visibility. ---
  let panelVisible = false;
  toggleBtn.addEventListener("click", () => {
    panelVisible = !panelVisible;
    panel.style.display = panelVisible ? "block" : "none";
  });

  // Initial panel build.
  rebuildPanel();

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
        selectedCounty = null;
        document.querySelector<HTMLElement>(".popup-chart")?.remove();
        return;
      }

      selectedCounty = county;
      const popupW = 344;
      const popupH = 430;
      const position = computePosition(svgEl, popupW, popupH);

      // Map metric to slope type for the popup chart series line.
      const metricToSlope: Record<MetricType, SlopeType> = {
        tmax: "tmax",
        tmean: "tmean",
        tmin: "tmin",
        true_dtr: "true_dtr",
        seasonal_amplitude: "seasonal_amplitude",
      };
      const chartSlopeType = metricToSlope[currentMetric];

      showPopupChart({
        container: mapContainer,
        county,
        position,
        slopeType: chartSlopeType,
        method: currentMethod,
        periodDeltaWindows: periodDeltaState
          ? { baseline: periodDeltaState.baseline, recent: periodDeltaState.recent }
          : undefined,
      }).then((updater) => {
        currentPopupUpdater = updater;
      });
    },
  });

  // Initial color update.
  const initialSvgEl = document.getElementById("choropleth-svg") as SVGSVGElement | null;
  if (initialSvgEl) {
    updateMapColors(initialSvgEl, {
      method: currentMethod,
      metric: currentMetric,
      dataset,
      colorScaleFn: slopeColorScale,
      domain: currentDomain,
    });
  }

  console.log(`Rendered ${dataset.counties.length} counties.`);
}

// Run the app.
main().catch((err) => {
  console.error("Failed to initialize county warming map:", err);
});

export { main };
