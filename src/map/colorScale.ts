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
 * Create a one-dimensional diverging color scale for True Diurnal Temperature Range (DTR).
 * Values below 0 map from max purple to white; values above 0 map from white to max green.
 * The scaling is symmetric: the extent is computed as the larger absolute value so that
 * color saturation is consistent on both sides of zero, and white appears at value 0.
 *
 * @param dtrDomain Asymmetric domain [min, max] for this specific metric's hue channel
 */
export function dtrColorScale(dtrDomain: [number, number]): (dtrSlope: number) => string {
  const dtrMin = dtrDomain[0];
  const dtrMax = dtrDomain[1];

  if (dtrMax <= dtrMin || !Number.isFinite(dtrMin) || !Number.isFinite(dtrMax)) {
    return () => "#f7f7f7";
  }

  // Purple for negative values, white at zero, green for positive values
  const purple = "#5e4fa2";
  const white = "#f7f7f7";
  const green = "#90b880";

  // Compute symmetric extent: use the larger absolute value to ensure color
  // saturation is consistent on both sides of zero.
  const extent = Math.max(Math.abs(dtrMin), Math.abs(dtrMax));

  if (extent <= 0) {
    return () => white;
  }

  // Left channel: -extent → 0 (purple → white)
  const negativeScale = scaleLinear<string>()
    .domain([dtrMin, 0])
    .range([purple, white])
    .interpolate(interpolateRgb);

  // Right channel: 0 → extent (white → green)
  const positiveScale = scaleLinear<string>()
    .domain([0, dtrMax])
    .range([white, green])
    .interpolate(interpolateRgb);

  return (dtrSlope: number): string => {
    const clamped = Math.max(dtrMin, Math.min(dtrMax, dtrSlope));
    if (!Number.isFinite(clamped)) return white;
    if (clamped <= 0) return negativeScale(clamped);
    return positiveScale(clamped);
  };
}

/**
 * Create a one-dimensional diverging color scale for Seasonal Amplitude.
 * Values below 0 map from max purple to white; values above 0 map from white to max green.
 * Uses the same Purple-White-Green palette as True DTR so both metrics share the same
 * visual language (negative = cooling/narrowing; positive = warming/widening).
 * The scaling is symmetric: the extent is computed as the larger absolute value so that
 * color saturation is consistent on both sides of zero, and white appears at value 0.
 *
 * @param ampDomain Asymmetric domain [min, max] for this specific metric's hue channel
 */
export function ampColorScale(ampDomain: [number, number]): (ampSlope: number) => string {
  const ampMin = ampDomain[0];
  const ampMax = ampDomain[1];

  if (ampMax <= ampMin || !Number.isFinite(ampMin) || !Number.isFinite(ampMax)) {
    return () => "#f7f7f7";
  }

  // Purple for negative values, white at zero, green for positive values
  const purple = "#5e4fa2";
  const white = "#f7f7f7";
  const green = "#90b880";

  // Compute symmetric extent: use the larger absolute value to ensure color
  // saturation is consistent on both sides of zero.
  const extent = Math.max(Math.abs(ampMin), Math.abs(ampMax));

  if (extent <= 0) {
    return () => white;
  }

  // Left channel: -extent → 0 (purple → white)
  const negativeScale = scaleLinear<string>()
    .domain([ampMin, 0])
    .range([purple, white])
    .interpolate(interpolateRgb);

  // Right channel: 0 → extent (white → green)
  const positiveScale = scaleLinear<string>()
    .domain([0, ampMax])
    .range([white, green])
    .interpolate(interpolateRgb);

  return (ampSlope: number): string => {
    const clamped = Math.max(ampMin, Math.min(ampMax, ampSlope));
    if (!Number.isFinite(clamped)) return white;
    if (clamped <= 0) return negativeScale(clamped);
    return positiveScale(clamped);
  };
}

export default slopeColorScale;
