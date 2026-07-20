// Creates and manages a small SVG line chart overlay that displays the active
// temperature series (tmax, tmin, tmean, or true DTR) for a selected county.

import { select } from "d3-selection";
import { scaleLinear } from "d3-scale";
import type {
  CountyDataset,
  MethodType,
  MetricType,
  PeriodDeltaWindows,
  YearWindow,
} from "@/types";
import type { SlopeType } from "@/data/loadCountyData";

// d3-axis has no TypeScript types in this package. Declare minimal interfaces.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AxisFn = (scale: any) => any;

/** Position for the popup overlay. */
export interface PopupPosition {
  x: number;
  y: number;
}

/** Units for method types. */
const METHOD_UNITS: Record<MethodType, string> = {
  trend: "\u00b0F/decade",
  period_delta: "\u00b0F",
};

/** Configuration options for updating the popup chart. */
export interface PopupUpdateOptions {
  /** The active metric/slope type (e.g., 'tmax', 'tmean', 'tmin'). */
  slopeType?: SlopeType;
  /** When "period_delta", uses windowed mean deltas instead of OLS slopes. */
  method?: MethodType;
  /** Baseline and recent windows for period delta mode. */
  periodDeltaWindows?: PeriodDeltaWindows;
}

/** Updater returned by showPopupChart for dynamic state updates. */
export interface PopupUpdater {
  /** Update the popup chart with new configuration options. */
  update(options: PopupUpdateOptions): void;
}

/** Options for showPopupChart. */
export interface PopupChartOptions {
  container: HTMLElement;
  county: NonNullable<CountyDataset["counties"]>[number];
  position: PopupPosition;
  slopeType: SlopeType;
  /** When "period_delta", uses windowed mean deltas instead of OLS slopes. */
  method?: MethodType;
  /** Baseline and recent windows (required when method is "period_delta"). */
  periodDeltaWindows?: { baseline: YearWindow; recent: YearWindow };
  onClose?: () => void;
  /** CSS selectors for elements that should NOT trigger the popup to close. */
  ignoreSelectors?: string[];
}

const CHART_WIDTH = 320;
const CHART_HEIGHT = 220;
const MARGIN = { top: 20, right: 15, bottom: 30, left: 40 };
const PLOT_WIDTH = CHART_WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;

const COLORS = {
  tmax: "#d73027",
  tmin: "#0571b0",
  tmean: "#4d4d4d",
  trueDtr: "#6a3d9b", // purple for DTR line
  seasonAmp: "#e6ab02", // amber for seasonal amplitude
  background: "#fff",
  gridLine: "#e8e8e8",
  textColor: "#333",
  baselineWindow: "rgba(5, 113, 176, 0.15)", // blue tint
  recentWindow: "rgba(215, 48, 39, 0.15)", // red tint
};

/** Labels used in the popup legend. */
const SERIES_LABELS: Record<SlopeType, string> = {
  tmax: "tmax (annual max)",
  tmin: "tmin (annual min)",
  tmean: "tmean (avg of tmax/tmin)",
  true_dtr: "true DTR",
  seasonal_amplitude: "seasonal amplitude",
};

/** Metrics to display in period delta mode. */
const PERIOD_DELTA_METRICS: Array<{ key: MetricType; label: string }> = [
  { key: "tmax", label: "Max" },
  { key: "tmean", label: "Avg" },
  { key: "tmin", label: "Min" },
  { key: "true_dtr", label: "DTR" },
  { key: "seasonal_amplitude", label: "Seasonal" },
];

/**
 * Compute the mean of values in [wStart, wEnd] inclusive from a year->value map.
 */
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

/**
 * Compute a period delta for a given county metric using the active windows.
 */
function computePeriodDelta(
  countyData: NonNullable<CountyDataset["counties"]>[number],
  metric: MetricType,
  baseline: YearWindow,
  recent: YearWindow,
): number {
  const series = countyData.series;
  if (!series || series.length === 0) return NaN;

  // Build a lookup from year to metric value.
  const yearToValue = new Map<number, number>();
  for (const record of series) {
    let val: number;
    switch (metric) {
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
        return NaN;
    }
    yearToValue.set(record.year, val);
  }

  const baselineMean = windowMean(yearToValue, baseline.start, baseline.end);
  const recentMean = windowMean(yearToValue, recent.start, recent.end);
  if (!Number.isFinite(baselineMean) || !Number.isFinite(recentMean)) return NaN;
  return recentMean - baselineMean;
}

/** Format a numeric value with sign prefix and color. */
function formatValue(
  value: number,
  warmColor: string,
  coolColor: string,
): { label: string; color: string } {
  if (!Number.isFinite(value)) return { label: "\u2014", color: COLORS.textColor };
  const valStr = Math.abs(value).toFixed(2);
  const isWarming = value > 0.001;
  const isCooling = value < -0.001;
  const color = isWarming ? warmColor : isCooling ? coolColor : COLORS.textColor;
  const prefix = isWarming ? "+" : isCooling ? "\u2212" : "";
  return { label: `${prefix}${valStr}`, color };
}

export async function showPopupChart(options: PopupChartOptions): Promise<PopupUpdater> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { axisBottom, axisLeft } = await import("d3-axis" as any);
  const { container, county, position, slopeType, onClose } = options;

  /** Map the active slope type to series values and color. */
  function getActiveSeries(): {
    values: number[];
    color: string;
    label: string;
    dashed: boolean;
  } {
    switch (slopeType) {
      case "tmax":
        return {
          values: county.series.map((d) => d.tmax ?? NaN),
          color: COLORS.tmax,
          label: SERIES_LABELS.tmax,
          dashed: false,
        };
      case "tmin":
        return {
          values: county.series.map((d) => d.tmin ?? NaN),
          color: COLORS.tmin,
          label: SERIES_LABELS.tmin,
          dashed: false,
        };
      case "tmean": {
        const meanVals = county.series.map((d) => {
          if (isNaN(d.tmax) || isNaN(d.tmin)) return NaN;
          return (d.tmax + d.tmin) / 2;
        });
        return {
          values: meanVals,
          color: COLORS.tmean,
          label: SERIES_LABELS.tmean,
          dashed: false,
        };
      }
      case "true_dtr":
        return {
          values: county.series.map((d) => d.true_dtr ?? NaN),
          color: COLORS.trueDtr,
          label: SERIES_LABELS.true_dtr,
          dashed: true,
        };
      case "seasonal_amplitude": {
        const ampVals = county.series.map((d) => {
          if (isNaN(d.tmax) || isNaN(d.tmin)) return NaN;
          return d.tmax - d.tmin;
        });
        return {
          values: ampVals,
          color: COLORS.seasonAmp,
          label: SERIES_LABELS.seasonal_amplitude,
          dashed: false,
        };
      }
    }
  }

  const activeSeries = getActiveSeries();

  // Remove any existing popup
  select(container).selectAll(".popup-chart").remove();

  // Create overlay container
  const overlay = select(container)
    .append("div")
    .attr("class", "popup-chart")
    .style("position", "absolute")
    .style("left", `${position.x}px`)
    .style("top", `${position.y}px`)
    .style("background", COLORS.background)
    .style("border-radius", "6px")
    .style("box-shadow", "0 4px 16px rgba(0,0,0,0.2)")
    .style("padding", "12px")
    .style("z-index", "1000")
    .style("font-family", "system-ui, -apple-system, sans-serif");

  // Close button
  overlay
    .append("button")
    .attr("class", "popup-close")
    .text("\u00D7")
    .style("position", "absolute")
    .style("top", "4px")
    .style("right", "8px")
    .style("border", "none")
    .style("background", "transparent")
    .style("font-size", "32px")
    .style("cursor", "pointer")
    .style("color", COLORS.textColor)
    .on("click", () => {
      overlay.remove();
      onClose?.();
    });

  // Title (county name)
  overlay
    .append("div")
    .attr("class", "popup-title")
    .text(`${county.name} County, ${county.state}`)
    .style("font-size", "13px")
    .style("font-weight", "600")
    .style("margin-bottom", "8px")
    .style("color", COLORS.textColor);

  // Helper to format a slope value with explicit sign prefix and appropriate color.
  function formatSlope(
    slope: number,
    warmColor: string,
    coolColor: string,
  ): { label: string; color: string } {
    const valStr = Math.abs(slope).toFixed(2);
    const isWarming = slope > 0.001;
    const isCooling = slope < -0.001;
    const color = isWarming ? warmColor : isCooling ? coolColor : COLORS.textColor;
    const prefix = isWarming ? "+" : isCooling ? "\u2212" : ""; // use Unicode minus (−) for reliability
    return { label: `${prefix}${valStr}`, color };
  }

  // Slopes container.
  const slopesDiv = overlay
    .append("div")
    .attr("class", "popup-slopes")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("gap", "3px")
    .style("margin-bottom", "8px")
    .style("min-width", "140px");

  // Chart SVG — container height must match CHART_HEIGHT so the SVG does not
  // overflow and overlap the legend below. Centered with margin: auto.
  const chartDiv = overlay
    .append("div")
    .attr("class", "popup-chart-svg-container")
    .style("width", `${CHART_WIDTH}px`)
    .style("height", `${CHART_HEIGHT - MARGIN.bottom}px`)
    .style("margin-left", "auto")
    .style("margin-right", "auto");

  const svg = chartDiv
    .append("svg")
    .attr("width", CHART_WIDTH)
    .attr("height", PLOT_HEIGHT + MARGIN.top + MARGIN.bottom)
    .style("display", "block");

  const g = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  // Prepare data for the active series
  const data = county.series;
  if (!data || data.length === 0) {
    // Return a no-op updater if there's no data.
    return { update: () => {} };
  }

  const years = data.map((d) => d.year);

  // Filter out NaN values for scale calculation
  const validValues = activeSeries.values.filter((v) => !isNaN(v));
  if (validValues.length === 0) {
    return { update: () => {} };
  }

  // X scale (years)
  const xMin = Math.min(...years);
  const xMax = Math.max(...years);
  const xScale = scaleLinear()
    .domain([xMin - 1, xMax + 1])
    .range([0, PLOT_WIDTH]);

  // Y scale — use only the active series data for proper scaling
  const yMin = Math.min(...validValues);
  const yMax = Math.max(...validValues);
  const yPad = (yMax - yMin) * 0.15 || 1;

  const yScale = scaleLinear()
    .domain([yMin - yPad, yMax + yPad])
    .range([PLOT_HEIGHT, 0]);

  // Shaded window indicator groups (layered before the series line).
  const windowLayer = g
    .insert("g", ".active-series-line")
    .attr("class", "window-indicators");

  // Baseline window shaded area.
  const baselineRect = windowLayer
    .append("rect")
    .attr("class", "window-rect baseline-window")
    .attr("y", 0)
    .attr("height", PLOT_HEIGHT)
    .attr("rx", 2)
    .attr("fill", COLORS.baselineWindow)
    .style("opacity", 0);

  // Recent window shaded area.
  const recentRect = windowLayer
    .append("rect")
    .attr("class", "window-rect recent-window")
    .attr("y", 0)
    .attr("height", PLOT_HEIGHT)
    .attr("rx", 2)
    .attr("fill", COLORS.recentWindow)
    .style("opacity", 0);

  // Grid lines
  const gridTicks = yScale.ticks(6);
  g.selectAll<SVGLineElement, number>(".grid-line")
    .data(gridTicks)
    .enter()
    .append("line")
    .attr("class", "grid-line")
    .attr("x1", 0)
    .attr("x2", PLOT_WIDTH)
    .attr("y1", (d: number) => yScale(d))
    .attr("y2", (d: number) => yScale(d))
    .attr("stroke", COLORS.gridLine)
    .attr("stroke-width", 0.5);

  // X axis
  g.append("g")
    .attr("class", "x-axis")
    .attr("transform", `translate(0,${PLOT_HEIGHT})`)
    .call(
      // axisBottom requires a linear scale; d3-axis types are incomplete in this package
      (axisBottom as ReturnType<AxisFn>)(xScale)
        .tickFormat((d: number) => `${Math.round(d)}`)
        .ticks(6),
    )
    .selectAll("text")
    .style("font-size", "9px")
    .attr("fill", COLORS.textColor);

  // Remove default axis lines and add label styling
  g.selectAll<SVGPathElement, unknown>(".x-axis path, .x-axis line")
    .style("stroke", COLORS.gridLine)
    .style("fill", "none");

  // Axis labels — fixed position for consistent °F label placement
  // With rotate(-90), 'y' controls horizontal offset from axis origin (positive = left/outside chart)
  g.append("text")
    .attr("class", "y-axis-label")
    .attr("transform", "rotate(-90)")
    .attr("x", -PLOT_HEIGHT / 2)
    .attr("y", -30)
    .attr("text-anchor", "middle")
    .style("font-size", "10px")
    .style("fill", COLORS.textColor)
    .text("\u00b0F");

  // Build line path for the active series only
  function buildActivePath(): string {
    let path = "";
    for (let i = 0; i < data.length; i++) {
      const cx = xScale(data[i].year);
      const cy = yScale(activeSeries.values[i]);
      if (isNaN(cy)) continue;
      path += (path === "" ? "M" : "L") + `${cx},${cy}`;
    }
    return path;
  }

  // Draw the active series line
  g.append("path")
    .attr("class", "active-series-line")
    .attr("d", buildActivePath)
    .attr("fill", "none")
    .attr("stroke", activeSeries.color)
    .attr("stroke-width", activeSeries.label === SERIES_LABELS.tmean ? 2.5 : 2)
    .attr("opacity", 0.8)
    .attr("stroke-dasharray", activeSeries.dashed ? "4,2" : null);

  // X axis label
  g.append("text")
    .attr("class", "x-axis-label")
    .attr("x", PLOT_WIDTH / 2)
    .attr("y", PLOT_HEIGHT + 25)
    .attr("text-anchor", "middle")
    .style("font-size", "10px")
    .style("fill", COLORS.textColor)
    .text("Year");
  g.append("g")
    .attr("class", "y-axis")
    .call((axisLeft as ReturnType<AxisFn>)(yScale).ticks(6))
    .selectAll("text")
    .style("font-size", "9px")
    .attr("fill", COLORS.textColor);

  // Remove default axis line
  g.selectAll(".y-axis path, .y-axis line").style("stroke", COLORS.gridLine);

  // Legend — show only the active series
  const legend = overlay
    .append("div")
    .attr("class", "popup-legend")
    .style("display", "flex")
    .style("align-items", "center")
    .style("gap", "6px")
    .style("margin-top", "24px")
    .style("font-size", "10px")
    .style("color", COLORS.textColor);

  const legItem = legend
    .append("span")
    .style("display", "flex")
    .style("align-items", "center")
    .style("gap", "4px");

  legItem
    .append("span")
    .style("display", "inline-block")
    .style("width", "16px")
    .style("height", activeSeries.dashed ? "0" : "3px")
    .style("background", activeSeries.dashed ? "transparent" : activeSeries.color)
    .style(
      "border-bottom",
      activeSeries.dashed ? `${2}px solid ${activeSeries.color}` : "none",
    )
    .style("border-radius", activeSeries.dashed ? "0" : "1px");

  legItem.append("span").text(activeSeries.label);

  // Close on Escape key
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      overlay.remove();
      onClose?.();
      document.removeEventListener("keydown", handleKeyDown);
    }
  };
  document.addEventListener("keydown", handleKeyDown);

  // Close when clicking outside the popup (bubble up to body)
  const handleClickOutside = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    // Check if the click is inside any of the ignored selectors.
    const isIgnored = options.ignoreSelectors?.some((selector) =>
      target.closest(selector),
    );
    if (!target.closest(".popup-chart") && !isIgnored) {
      overlay.remove();
      onClose?.();
      document.removeEventListener("click", handleClickOutside);
    }
  };
  // Delay so initial click on the county doesn't immediately close
  setTimeout(() => {
    document.addEventListener("click", handleClickOutside);
  }, 100);

  /** Populate the slopes/div delta text elements. */
  function populateSlopesText(
    periodWindows: PeriodDeltaWindows,
    isPeriod: boolean,
  ): void {
    // Clear existing text nodes from slopesDiv (keep the element itself).
    slopesDiv.selectAll("*").remove();

    if (isPeriod) {
      const units = METHOD_UNITS.period_delta;
      for (const { key, label } of PERIOD_DELTA_METRICS) {
        const delta = computePeriodDelta(
          county,
          key,
          periodWindows.baseline,
          periodWindows.recent,
        );
        const styled = formatValue(delta, COLORS.tmax, COLORS.tmin);
        slopesDiv
          .append("div")
          .style("font-size", "11px")
          .style("font-weight", "500")
          .style("color", styled.color)
          .text(`${label}: ${styled.label} ${units}`);
      }
    } else {
      // Trend mode: show OLS slopes from the precomputed dataset.
      const tmaxSlope = formatSlope(county.slopeTMax, COLORS.tmax, COLORS.tmin);
      slopesDiv
        .append("div")
        .style("font-size", "11px")
        .style("font-weight", "500")
        .style("color", tmaxSlope.color)
        .text(`Max: ${tmaxSlope.label} °F/decade`);

      const tmeanSlope = formatSlope(county.slopeTMean, COLORS.tmax, COLORS.tmin);
      slopesDiv
        .append("div")
        .style("font-size", "11px")
        .style("font-weight", "500")
        .style("color", tmeanSlope.color)
        .text(`Avg: ${tmeanSlope.label} °F/decade`);

      const tminSlope = formatSlope(county.slopeTMin, COLORS.tmax, COLORS.tmin);
      slopesDiv
        .append("div")
        .style("font-size", "11px")
        .style("font-weight", "500")
        .style("color", tminSlope.color)
        .text(`Min: ${tminSlope.label} °F/decade`);

      const trueDtrSlope = formatSlope(county.slopeTrueDTR, COLORS.tmax, COLORS.tmin);
      slopesDiv
        .append("div")
        .style("font-size", "11px")
        .style("font-weight", "500")
        .style("color", trueDtrSlope.color)
        .text(`DTR: ${trueDtrSlope.label} °F/decade`);

      const seasonAmpSlope = formatSlope(
        county.slopeSeasonalAmplitude,
        COLORS.tmax,
        COLORS.tmin,
      );
      slopesDiv
        .append("div")
        .style("font-size", "11px")
        .style("font-weight", "500")
        .style("color", seasonAmpSlope.color)
        .text(`Seasonal change: ${seasonAmpSlope.label} °F/decade`);
    }
  }

  /** Update the window indicator rectangles on the SVG. */
  function updateWindowIndicators(
    periodWindows: PeriodDeltaWindows,
    isPeriod: boolean,
  ): void {
    if (isPeriod) {
      const bLeft = xScale(Math.max(periodWindows.baseline.start, xScale.domain()[0]));
      const bRight = xScale(Math.min(periodWindows.baseline.end, xScale.domain()[1]));
      const bWidth = Math.max(0, bRight - bLeft);
      baselineRect.attr("x", bLeft).attr("width", bWidth).style("opacity", 1);

      const rLeft = xScale(Math.max(periodWindows.recent.start, xScale.domain()[0]));
      const rRight = xScale(Math.min(periodWindows.recent.end, xScale.domain()[1]));
      const rWidth = Math.max(0, rRight - rLeft);
      recentRect.attr("x", rLeft).attr("width", rWidth).style("opacity", 1);
    } else {
      baselineRect.style("opacity", 0).attr("width", 0);
      recentRect.style("opacity", 0).attr("width", 0);
    }
  }

  // Capture initial options for closure references.
  const opts = {
    slopeType,
    method: options.method,
    periodDeltaWindows: options.periodDeltaWindows,
  };

  // Initial population of slopes and window indicators.
  const isPeriodInitial = opts.method === "period_delta";
  populateSlopesText(
    {
      baseline: options.periodDeltaWindows?.baseline ?? { start: xMin, end: xMin },
      recent: options.periodDeltaWindows?.recent ?? { start: xMax, end: xMax },
    },
    isPeriodInitial,
  );
  updateWindowIndicators(
    {
      baseline: options.periodDeltaWindows?.baseline ?? { start: xMin, end: xMin },
      recent: options.periodDeltaWindows?.recent ?? { start: xMax, end: xMax },
    },
    isPeriodInitial,
  );

  // Return the updater function.
  return {
    update(updateOptions: PopupUpdateOptions): void {
      // Track whether method changed in this update so we can sync opts.method.
      const methodChanged = updateOptions.method !== undefined;
      if (methodChanged) {
        opts.method = updateOptions.method;
      }

      // Compute the current "is period" status from the most recent method.
      const currentIsPeriod = opts.method === "period_delta";

      // Update slope/delta text if method or period windows changed.
      if (methodChanged || updateOptions.periodDeltaWindows !== undefined) {
        const currentWindows = updateOptions.periodDeltaWindows ?? {
          baseline: opts.periodDeltaWindows?.baseline ?? { start: xMin, end: xMin },
          recent: opts.periodDeltaWindows?.recent ?? { start: xMax, end: xMax },
        };
        populateSlopesText(currentWindows, currentIsPeriod);
        updateWindowIndicators(currentWindows, currentIsPeriod);
      }

      // Update the series line if slope type changed.
      if (
        updateOptions.slopeType !== undefined &&
        updateOptions.slopeType !== opts.slopeType
      ) {
        const newActiveSeries = getActiveSeriesForType(updateOptions.slopeType);
        updateSeriesLine(newActiveSeries);
        updateLegend(newActiveSeries);
        opts.slopeType = updateOptions.slopeType;
      }
    },
  };

  /** Helper to compute series for a given slope type. */
  function getActiveSeriesForType(sType: SlopeType): {
    values: number[];
    color: string;
    label: string;
    dashed: boolean;
  } {
    switch (sType) {
      case "tmax":
        return {
          values: county.series.map((d) => d.tmax ?? NaN),
          color: COLORS.tmax,
          label: SERIES_LABELS.tmax,
          dashed: false,
        };
      case "tmin":
        return {
          values: county.series.map((d) => d.tmin ?? NaN),
          color: COLORS.tmin,
          label: SERIES_LABELS.tmin,
          dashed: false,
        };
      case "tmean": {
        const meanVals = county.series.map((d) => {
          if (isNaN(d.tmax) || isNaN(d.tmin)) return NaN;
          return (d.tmax + d.tmin) / 2;
        });
        return {
          values: meanVals,
          color: COLORS.tmean,
          label: SERIES_LABELS.tmean,
          dashed: false,
        };
      }
      case "true_dtr":
        return {
          values: county.series.map((d) => d.true_dtr ?? NaN),
          color: COLORS.trueDtr,
          label: SERIES_LABELS.true_dtr,
          dashed: true,
        };
      case "seasonal_amplitude": {
        const ampVals = county.series.map((d) => {
          if (isNaN(d.tmax) || isNaN(d.tmin)) return NaN;
          return d.tmax - d.tmin;
        });
        return {
          values: ampVals,
          color: COLORS.seasonAmp,
          label: SERIES_LABELS.seasonal_amplitude,
          dashed: false,
        };
      }
    }
  }

  /** Helper to rebuild Y scale from a series' valid values. */
  function computeYScale(
    values: number[],
  ): import("d3-scale").ScaleLinear<number, number> {
    const valid = values.filter((v) => !isNaN(v));
    if (valid.length === 0) {
      return scaleLinear().domain([0, 1]).range([PLOT_HEIGHT, 0]);
    }
    const yMin = Math.min(...valid);
    const yMax = Math.max(...valid);
    const yPad = (yMax - yMin) * 0.15 || 1;
    return scaleLinear()
      .domain([yMin - yPad, yMax + yPad])
      .range([PLOT_HEIGHT, 0]);
  }

  /** Helper to update the series path and styling. */
  function updateSeriesLine(activeSeries: {
    values: number[];
    color: string;
    dashed: boolean;
  }): void {
    const newYScale = computeYScale(activeSeries.values);

    // Rebuild the line path using the new scale.
    let path = "";
    for (let i = 0; i < data.length; i++) {
      const cx = xScale(data[i].year);
      const cy = newYScale(activeSeries.values[i]);
      if (isNaN(cy)) continue;
      path += (path === "" ? "M" : "L") + `${cx},${cy}`;
    }

    // Update the series line.
    g.select(".active-series-line")
      .attr("d", path)
      .attr("stroke", activeSeries.color)
      .attr("stroke-dasharray", activeSeries.dashed ? "4,2" : null);

    // Update Y axis ticks with new scale.
    g.select(".y-axis").call(axisLeft(newYScale).ticks(6));
    g.selectAll<SVGTextElement, number>(".y-axis text")
      .style("font-size", "9px")
      .attr("fill", COLORS.textColor);

    // Update grid lines.
    const newGridTicks = newYScale.ticks(6);
    const gridLines = g
      .selectAll<SVGLineElement, number>(".grid-line")
      .data(newGridTicks);
    gridLines.exit().remove();
    gridLines
      .attr("y1", (d: number) => newYScale(d))
      .attr("y2", (d: number) => newYScale(d));
    gridLines
      .enter()
      .append("line")
      .attr("class", "grid-line")
      .attr("x1", 0)
      .attr("x2", PLOT_WIDTH)
      .attr("y1", (d: number) => newYScale(d))
      .attr("y2", (d: number) => newYScale(d))
      .attr("stroke", COLORS.gridLine)
      .attr("stroke-width", 0.5);
  }

  /** Helper to update the legend text and styling. */
  function updateLegend(activeSeries: {
    color: string;
    label: string;
    dashed: boolean;
  }): void {
    const legItem = legend.select("span");
    legItem
      .select("span:first-child")
      .style("height", activeSeries.dashed ? "0" : "3px")
      .style("background", activeSeries.dashed ? "transparent" : activeSeries.color)
      .style(
        "border-bottom",
        activeSeries.dashed ? `${2}px solid ${activeSeries.color}` : "none",
      );
    legItem.select("span:last-child").text(activeSeries.label);
  }
}
