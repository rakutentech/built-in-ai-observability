import { defineConfig } from "tsdown";

/**
 * Bundles the SDK and its OpenTelemetry dependencies into dist/sdk.js, one ES module the
 * page imports as-is. This is the only build step: the example's own files are served unchanged.
 */
export default defineConfig({
  clean: true,
  deps: { alwaysBundle: [/.*/u] },
  dts: false,
  entry: { sdk: "sdk-entry.js" },
  format: ["esm"],
  outExtensions: () => ({ js: ".js" }),
  platform: "browser",
  sourcemap: true,
  target: "es2022",
});
