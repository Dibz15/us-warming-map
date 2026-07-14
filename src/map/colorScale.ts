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

export default slopeColorScale;
