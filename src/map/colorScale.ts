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
 * @param domainExtent Maximum absolute value of the domain
 *   (e.g., `0.05` means domain is `[-0.05, 0.05]`).
 */
export function slopeColorScale(domainExtent: number): (slope: number) => string {
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
