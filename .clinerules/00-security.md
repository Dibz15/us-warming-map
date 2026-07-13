# .clinerules/00-security.md

## Access policy
- Do NOT modify files outside this repository.
- Do NOT read or print credential files (`.env`, `*.key`, `*.pem`,
  `secrets/`, anything under `~/.ssh`). This repo has no secrets checked
  in — if something that looks like one turns up, stop and flag it rather
  than reading further.
- Do NOT modify `.github/workflows/*.yml` without explicit confirmation.
  These control real deployments (`permissions: contents: write,
  pages: write, id-token: write`) — a bad change here has a bigger blast
  radius than a source-file bug.


## Shell commands
- Routine, read-only, or easily-reversible commands do NOT need
  per-command confirmation: `npm install`, `npm run build`, `npm run
  serve`, `grep`, `node --check`, `git status`, `git diff`, `git log`.
- Anything destructive, network-mutating, or outside that set — `git
  push`, `git commit`, creating/pushing tags, `rm -rf`, installing new
  packages, `sudo`, changing file permissions, hitting arbitrary URLs —
  requires explicit confirmation first. ASK, DON'T ASSUME.

## Git / CI
- NEVER commit or push directly to `main`. A push to `main` triggers an
  immediate live deploy via `deploy.yml` — always work on a branch and
  open a PR, even for small fixes.
- Never create or push a version tag (`vX.Y.Z`). That triggers
  `release.yml`, which publishes a public, downloadable GitHub Release —
  that's a user decision, not something to do as a side effect of a task.
- Do NOT add new dependencies to `package.json` without confirmation — every dependency added is new code shipping inside
  the offline HTML.

## Code standards
- Follow existing naming and style conventions already in the codebase