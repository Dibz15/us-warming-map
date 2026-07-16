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
- When executing shell commands that involve pipe filtering (grep, head, tail, awk, etc.):
  1. Always split into two steps using a temporary file instead of pipes.
  2. For commands that connect to network services (smbclient, curl, nc, ssh, etc.),
     always prefix with 'timeout 30'.
  3. Never combine a network connection command with pipe-based filtering in a single
     command invocation.
  4. If all else fails (command keeps timing out, for example) prompt the user to run the required command and feed the output back to your chat.
- When writing a plan in "plan mode", keep in mind that the model used in "act mode" is less capable and should be given more explicit plan instructions.
