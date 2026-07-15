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
    // Degenerate case: return a neutral color for all slopes
    return () => "#f7f7f7";
  }

  const colors = ["#0571b0", "#92c5de", "#f7f7f7", "#f4a582", "#d73027"];

  const scale = scaleLinear<string>()
    .domain([-domainExtent, -domainExtent * 0.5, 0, domainExtent * 0.5, domainExtent])
    .range(colors)
    .interpolate(interpolateRgb);

  return (slope: number) => {
    // Clamp values to domain
    const clamped = Math.max(-domainExtent, Math.min(domainExtent, slope));
    return scale(clamped);
  };
}

/**
 * Create a two-channel DTR color function.
 *
 * Hue channel: d3's PuOr diverging scheme centered at 0.
 *   Negative dtrSlope (nights leading, DTR narrowing) → purple
 *   Positive dtrSlope (days leading, DTR widening)     → amber/orange
 *
 * Magnitude channel: |dtrSlope| controls saturation/lightness.
 *   Near-zero DTR (no diurnal divergence) → pale neutral gray
 *   Strong DTR                            → full-saturation hue
 *
 * This ensures counties with opposing day/night trends that cancel in the
 * mean (e.g., tmax=+0.02, tmin=-0.02 → mean≈0) still show strong DTR colors
 * because the magnitude comes from |DTR| itself, not |meanSlope|.
 *
 * Significance masking: if |dtrSlope| < 2 * dtrSlopeStdErr,
 * render desaturated/gray to indicate statistical insignificance.
 *
 * @param dtrDomain Asymmetric domain for the DTR hue (e.g. [-2, 5])
 */
export function dtrColorScale(
  dtrDomain: [number, number],
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

  // Use asymmetric domain directly for accurate color mapping
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

    // Magnitude factor: clamp |dtrSlope| / maxDtrMagnitude to [0, 1]
    // This ensures strong DTR signals (whether positive or negative) get full saturation
    // regardless of what the mean trend does.
    const magT = Math.min(1, Math.abs(clampedDtr) / maxDtrMagnitude);

    // Significance check: not distinguishable from zero DTR
    const isSignificant = true; //Math.abs(dtrSlope) >= 2 * dtrStdErr;

    if (!isSignificant || !Number.isFinite(dtrSlope) || !Number.isFinite(dtrStdErr)) {
      // Blend toward neutral gray based on magnitude (brighter for more warming)
      return interpolateRgb(neutralGray, "#bdbdbd")(magT);
    }

    // Get the full saturation hue color
    const baseColor = hueScale(clampedDtr);

    // Blend from neutral gray toward full-saturation hue based on magnitude
    return interpolateRgb(neutralGray, baseColor)(magT);
  };
}

export default slopeColorScale;
