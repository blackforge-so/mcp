import { resolve } from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds `widget/chart.html` into ONE self-contained file at
// `dist/widget/chart.html` — uPlot, the app SDK, our JS and all CSS inlined.
//
// Single-file is not a convenience here, it is the security contract. MCP Apps
// render under a deny-by-default CSP (`default-src 'none'`), so anything left
// as an external <script> or <link> would simply not load. The alternative is
// declaring `_meta.ui.csp.resourceDomains` for a CDN, which trades a 60 KB file
// for a runtime dependency on someone else's uptime inside a sandboxed frame.
export default defineConfig({
  // Rooted at `widget/` so the emitted path is `dist/widget/chart.html` rather
  // than `dist/widget/widget/chart.html` — rollup mirrors the input's path
  // relative to the root, and `src/widget.ts` reads that exact filename.
  root: "widget",
  plugins: [viteSingleFile()],
  build: {
    outDir: "../dist/widget",
    emptyOutDir: true,
    // Absolute: rollup resolves `input` against the CWD, not against `root`.
    rollupOptions: { input: resolve(import.meta.dirname, "widget/chart.html") },
  },
});
