# Workflow expectations

- This repo's package versions were installed and resolved live against the
  npm registry (see `package-lock.json`) — don't casually bump or re-pin
  versions without reinstalling and checking the lockfile updates cleanly.
- When implementing a stubbed module, remove its `throw new Error("not
  implemented")` and the "Not implemented yet" comment, but keep the rest of
  the file's explanatory header comment unless it's now inaccurate.
- Prefer small, reviewable commits scoped to one module (e.g. "implement
  color scale", "implement popup chart") over one large commit.
- If a change requires a new npm package, install it with `npm install`
  (not by hand-editing `package.json`) so the lockfile stays consistent.
- Ask before adding a mapping/charting library beyond what's already in
  `package.json` (d3-* modules, topojson-client, us-atlas) — the intent is
  to keep the bundle minimal.
