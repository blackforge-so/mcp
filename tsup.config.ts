import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  // `clean` wipes the WHOLE of dist/, including dist/widget/. That is why the
  // `build` script runs tsup FIRST and the vite widget build second — reversed,
  // it silently deletes the widget and the server serves a missing resource.
  clean: true,
  // tsup preserves the `#!/usr/bin/env node` shebang from src/index.ts.
});
