import { defineConfig } from "vite";

// When building in GitHub Actions, GITHUB_REPOSITORY is "owner/repo".
// Project pages are served from https://owner.github.io/repo/, so the
// base path must match the repo name. Locally (npm run dev) this falls
// back to "/".
const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
const base = process.env.CI && repoName ? `/${repoName}/` : "/";

export default defineConfig({
  base,
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
