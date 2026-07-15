// Creates and manages a small SVG line chart overlay that displays annual
// max/min temperature bounds plus a mean trend line for a selected county.

import { select } from "d3-selection";
import { scaleLinear } from "d3-scale";
import type { CountyDataset } from "@/types";

// d3-axis has no TypeScript types in this package. Declare minimal interfaces.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AxisFn = (scale: any) => any;

/** Position for the popup overlay. */
export interface PopupPosition {
  x: number;
  y: number;
}

/** Options for showPopupChart. */
export interface PopupChartOptions {
  container: HTMLElement;
  county: NonNullable<CountyDataset["counties"]>[number];
  position: PopupPosition;
  onClose?: () => void;
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
  background: "#fff",
  gridLine: "#e8e8e8",
  textColor: "#333",
};

export async function showPopupChart(options: PopupChartOptions): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { axisBottom, axisLeft } = await import("d3-axis" as any);
  const { container, county, position, onClose } = options;

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
    .style("font-size", "18px")
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

  // Create a slopes container with all three trends.
  const slopesDiv = overlay
    .append("div")
    .attr("class", "popup-slopes")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("gap", "3px")
    .style("margin-bottom", "8px")
    .style("min-width", "140px"); // Ensure space for ±X.XX °F/decade labels

  // Tmax slope
  const tmaxSlope = formatSlope(county.slopeTMax, COLORS.tmax, COLORS.tmin);
  slopesDiv
    .append("div")
    .style("font-size", "11px")
    .style("font-weight", "500")
    .style("color", tmaxSlope.color)
    .text(`${tmaxSlope.label} °F/decade (Tmax)`);

  // Tmean slope
  const tmeanSlope = formatSlope(county.slopeTMean, COLORS.tmax, COLORS.tmin);
  slopesDiv
    .append("div")
    .style("font-size", "11px")
    .style("font-weight", "500")
    .style("color", tmeanSlope.color)
    .text(`${tmeanSlope.label} °F/decade (Tmean)`);

  // Tmin slope
  const tminSlope = formatSlope(county.slopeTMin, COLORS.tmax, COLORS.tmin);
  slopesDiv
    .append("div")
    .style("font-size", "11px")
    .style("font-weight", "500")
    .style("color", tminSlope.color)
    .text(`${tminSlope.label} °F/decade (Tmin)`);

  // Chart SVG
  const chartDiv = overlay
    .append("div")
    .attr("class", "popup-chart-svg-container")
    .style("width", `${CHART_WIDTH}px`)
    .style("height", `${PLOT_HEIGHT + MARGIN.top + 5}px`);

  const svg = chartDiv
    .append("svg")
    .attr("width", CHART_WIDTH)
    .attr("height", PLOT_HEIGHT + MARGIN.top + MARGIN.bottom)
    .style("display", "block");

  const g = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  // Prepare data
  const data = county.series;
  if (!data || data.length === 0) return;

  const years = data.map((d) => d.year);
  const tmaxValues = data.map((d) => d.tmax ?? NaN).filter((v) => !isNaN(v));
  const tminValues = data.map((d) => d.tmin ?? NaN).filter((v) => !isNaN(v));

  // X scale (years)
  const xMin = Math.min(...years);
  const xMax = Math.max(...years);
  const xScale = scaleLinear()
    .domain([xMin - 1, xMax + 1])
    .range([0, PLOT_WIDTH]);

  // Y scale (temperature) — use full range from all data
  const allTemps = [...tmaxValues, ...tminValues].filter((v) => !isNaN(v));
  const yMin = Math.min(...allTemps);
  const yMax = Math.max(...allTemps);
  const yPad = (yMax - yMin) * 0.15 || 1;

  const yScale = scaleLinear()
    .domain([yMin - yPad, yMax + yPad])
    .range([PLOT_HEIGHT, 0]);

  // Grid lines — yScale.ticks() returns number[]
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

  // Remove default axis lines
  g.selectAll<SVGPathElement, unknown>(".x-axis path, .x-axis line")
    .style("stroke", COLORS.gridLine)
    .style("fill", "none");

  // Y axis
  g.append("g")
    .attr("class", "y-axis")
    .call((axisLeft as ReturnType<AxisFn>)(yScale).ticks(6))
    .selectAll("text")
    .style("font-size", "9px")
    .attr("fill", COLORS.textColor);

  // Remove default axis line
  g.selectAll(".y-axis path, .y-axis line").style("stroke", COLORS.gridLine);

  // Axis labels
  g.append("text")
    .attr("class", "x-axis-label")
    .attr("x", PLOT_WIDTH / 2)
    .attr("y", PLOT_HEIGHT + 25)
    .attr("text-anchor", "middle")
    .style("font-size", "10px")
    .style("fill", COLORS.textColor)
    .text("Year");

  g.append("text")
    .attr("class", "y-axis-label")
    .attr("transform", "rotate(-90)")
    .attr("x", -PLOT_HEIGHT / 2)
    .attr("y", -30)
    .attr("text-anchor", "middle")
    .style("font-size", "10px")
    .style("fill", COLORS.textColor)
    .text("°F");

  // Build line path strings manually to avoid d3-shape typing issues
  function buildPath(values: number[]): string {
    let path = "";
    for (let i = 0; i < data.length; i++) {
      const cx = xScale(data[i].year);
      const cy = yScale(values[i]);
      if (isNaN(cy)) continue;
      path += (path === "" ? "M" : "L") + `${cx},${cy}`;
    }
    return path;
  }

  // tmax line
  g.append("path")
    .attr("class", "tmax-line")
    .attr("d", () => buildPath(data.map((d) => d.tmax ?? NaN)))
    .attr("fill", "none")
    .attr("stroke", COLORS.tmax)
    .attr("stroke-width", 1.5)
    .attr("opacity", 0.6);

  // tmin line
  g.append("path")
    .attr("class", "tmin-line")
    .attr("d", () => buildPath(data.map((d) => d.tmin ?? NaN)))
    .attr("fill", "none")
    .attr("stroke", COLORS.tmin)
    .attr("stroke-width", 1.5)
    .attr("opacity", 0.6);

  // tmean line (average of tmax and tmin where both are valid)
  g.append("path")
    .attr("class", "tmean-line")
    .attr("d", () =>
      buildPath(
        data.map((d) => {
          if (isNaN(d.tmax) || isNaN(d.tmin)) return NaN;
          return (d.tmax + d.tmin) / 2;
        }),
      ),
    )
    .attr("fill", "none")
    .attr("stroke", COLORS.tmean)
    .attr("stroke-width", 2.5);

  // Legend
  const legend = overlay
    .append("div")
    .attr("class", "popup-legend")
    .style("display", "flex")
    .style("gap", "12px")
    .style("margin-top", "6px")
    .style("font-size", "9px")
    .style("color", COLORS.textColor);

  const legendItems = [
    { label: "tmax (annual max)", color: COLORS.tmax },
    { label: "tmin (annual min)", color: COLORS.tmin },
    { label: "tmean (avg of tmax/tmin)", color: COLORS.tmean },
  ];

  for (const item of legendItems) {
    const legItem = legend
      .append("span")
      .style("display", "flex")
      .style("align-items", "center")
      .style("gap", "3px");
    legItem
      .append("span")
      .style("display", "inline-block")
      .style("width", "12px")
      .style("height", "2px")
      .style("background", item.color);
    legItem.append("span").text(item.label);
  }

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
    if (!target.closest(".popup-chart")) {
      overlay.remove();
      onClose?.();
      document.removeEventListener("click", handleClickOutside);
    }
  };
  // Delay so initial click on the county doesn't immediately close
  setTimeout(() => {
    document.addEventListener("click", handleClickOutside);
  }, 100);
}
