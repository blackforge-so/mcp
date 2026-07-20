import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  // tsup preserves the `#!/usr/bin/env node` shebang from src/index.ts.
});
