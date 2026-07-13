// Diverging blue/white/red scale mapping warming slope (°F/decade) to color.
// Domain should be centered on 0 with a symmetric extent (e.g. via a max
// absolute slope across all counties) so "no trend" is always white.
//
// Not implemented yet — scaffolding only.

export function slopeColorScale(_domainExtent: number): (slope: number) => string {
  throw new Error("not implemented");
}
