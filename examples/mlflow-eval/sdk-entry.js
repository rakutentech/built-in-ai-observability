// Entry for dist/sdk.js (see tsdown.config.ts): the SDK and its OpenTelemetry dependencies in one
// ES module the page imports as-is.

// biome-ignore lint/performance/noBarrelFile: this file exists to re-export one bundle.
export * from "@built-in-ai-obs/sdk-browser";
