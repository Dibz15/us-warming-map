// Diverging blue/white/red scale mapping warming slope (°F/decade) to color.
// Domain is centered on 0 with symmetric extent so "no trend" is always white.
// Uses ColorBrewer RdBu-inspired colors for colorblind safety:
//   - Blue (#0571b0) for cooling trends
//   - White (#f7f7f7) for zero trend
//   - Red (#d73027) for warming trends

import { scaleLinear } from "d3-scale";
import { interpolateRgb } from "d3-interpolate";

/**
 * Create a color scale function for temperature slopes.
 * @param domain A two-element array `[min, max]` representing the data domain.
 *   The scale is centered on 0 and uses the larger absolute value as the extent
 *   to maintain symmetry (ensuring "no trend" stays white).
 */
export function slopeColorScale(domain: [number, number]): (slope: number) => string {
  const absMin = Math.abs(domain[0]);
  const absMax = Math.abs(domain[1]);
  const domainExtent = Math.max(absMin, absMax);

  if (domainExtent <= 0) {
    return () => "#f7f7f7";
  }

  const colors = ["#0571b0", "#92c5de", "#f7f7f7", "#f4a582", "#d73027"];

  const scale = scaleLinear<string>()
    .domain([-domainExtent, -domainExtent * 0.5, 0, domainExtent * 0.5, domainExtent])
    .range(colors)
    .interpolate(interpolateRgb);

  return (slope: number) => {
    const clamped = Math.max(-domainExtent, Math.min(domainExtent, slope));
    return scale(clamped);
  };
}

/**
 * Create a two-channel DTR color function with its own independent domain.
 * Each metric type should get its own separate `dtrColorScale` call so that the
 * internal magnitude calculations don't cross-contaminate between metrics.
 *
 * @param dtrDomain Asymmetric domain for this specific metric's hue channel
 * @param magLevels Optional array of saturation levels per row [top, middle, bottom]
 */
export function dtrColorScale(
  dtrDomain: [number, number],
  magnitudeOverride?: number,
): (dtrSlope: number, _meanSlope: number, dtrStdErr: number) => string {
  // PuOr diverging palette — purple (narrowing) ↔ amber/orange (widening)
  const hueColors = [
    "#5e4fa2", // deep purple (negative)
    "#7b3291",
    "#c2a5cf",
    "#f7f7f7", // neutral gray/white (zero)
    "#d6dba0",
    "#dfc27a",
    "#fc8d59", // amber/orange (positive)
  ];

  const dtrMin = dtrDomain[0];
  const dtrMax = dtrDomain[1];

  if (dtrMax <= dtrMin) {
    return () => "#e0e0e0"; // pale neutral gray
  }

  const dtrExtentNeg = Math.abs(dtrMin);
  const dtrExtentPos = dtrMax;

  // Diverging hue scale from purple to amber via PuOr-inspired colors
  const hueScale = scaleLinear<string>()
    .domain([dtrMin, dtrMin * 0.5, 0, dtrMax * 0.5, dtrMax])
    .range(hueColors)
    .interpolate(interpolateRgb);

  // Neutral pale gray base for low-magnitude DTR counties
  const neutralGray = "#e8e8e8";

  // Maximum |DTR| for magnitude blending (use the larger extent)
  const maxDtrMagnitude = Math.max(dtrExtentNeg, dtrExtentPos);

  // Keep meanSlope in the signature for API compatibility with callers, but
  // prefix with _ so TypeScript knows it's intentionally unused.
  return (dtrSlope: number, _meanSlope: number, dtrStdErr: number): string => {
    // Clamp DTR to domain
    const clampedDtr = Math.max(dtrMin, Math.min(dtrMax, dtrSlope));

    // Magnitude factor: use override if provided, otherwise derive from |clampedDtr|.
    const magT =
      magnitudeOverride != null
        ? Math.max(0, Math.min(1, magnitudeOverride))
        : Math.min(1, Math.abs(clampedDtr) / maxDtrMagnitude);

    // Significance check: not distinguishable from zero DTR
    const isSignificant = true; //Math.abs(dtrSlope) >= 2 * dtrStdErr;

    if (!isSignificant || !Number.isFinite(dtrSlope) || !Number.isFinite(dtrStdErr)) {
      return interpolateRgb(neutralGray, "#bdbdbd")(magT);
    }

    // Get the full saturation hue color
    const baseColor = hueScale(clampedDtr);

    // Blend from neutral gray toward full-saturation hue based on magnitude
    return interpolateRgb(neutralGray, baseColor)(magT);
  };
}

/**
 * Create a separate DTR color function specifically for Seasonal Amplitude.
 * Uses a distinct amplitude-specific palette (Teal-Olive) to visually distinguish
 * it from True DTR (Purple-Amber), preventing the two metrics from looking identical.
 *
 * @param ampDomain Domain for seasonal amplitude hue channel
 * @param magLevels Optional array of saturation levels per row [top, middle, bottom]
 */
export function ampColorScale(
  ampDomain: [number, number],
  magnitudeOverride?: number,
): (ampSlope: number, _meanSlope: number, stdErr: number) => string {
  // Teal-Olive diverging palette — blue-green (narrowing) ↔ olive-brown (widening)
  const ampColors = [
    "#2c7fb8", // deep blue-green (negative)
    "#41b6c4",
    "#a1dab4",
    "#f7f7f7", // neutral gray/white (zero)
    "#ecc850",
    "#d9af8a",
    "#ca1834", // deep red-brown (positive)
  ];

  const ampMin = ampDomain[0];
  const ampMax = ampDomain[1];

  if (ampMax <= ampMin) {
    return () => "#e0e0e0";
  }

  const ampExtentNeg = Math.abs(ampMin);
  const ampExtentPos = ampMax;

  // Diverging hue scale from blue-green to red-brown via Teal-Olive-inspired colors
  const ampHueScale = scaleLinear<string>()
    .domain([ampMin, ampMin * 0.5, 0, ampMax * 0.5, ampMax])
    .range(ampColors)
    .interpolate(interpolateRgb);

  const neutralGray = "#e8e8e8";
  const maxAmpMagnitude = Math.max(ampExtentNeg, ampExtentPos);

  return (ampSlope: number, _meanSlope: number, stdErr: number): string => {
    const clampedAmp = Math.max(ampMin, Math.min(ampMax, ampSlope));

    const magT =
      magnitudeOverride != null
        ? Math.max(0, Math.min(1, magnitudeOverride))
        : Math.min(1, Math.abs(clampedAmp) / maxAmpMagnitude);

    const isSignificant = true;

    if (!isSignificant || !Number.isFinite(ampSlope) || !Number.isFinite(stdErr)) {
      return interpolateRgb(neutralGray, "#bdbdbd")(magT);
    }

    const baseColor = ampHueScale(clampedAmp);
    return interpolateRgb(neutralGray, baseColor)(magT);
  };
}

export default slopeColorScale;
