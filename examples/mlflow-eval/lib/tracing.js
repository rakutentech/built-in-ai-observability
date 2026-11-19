// Tracing. There is almost nothing to do: the Built-in AI Observability SDK patches the Prompt API
// and sends every call to MLflow as a trace. Nothing in the agent is instrumented by hand.
//
// The one catch: the SDK does not tell us the ID of the trace it just sent. Scoring needs that ID
// (scores are attached to a trace), so findTrace() looks the trace up in MLflow afterwards.

import { client, experimentId, settings } from "../config.js";
import { BuiltInAIObservability } from "../dist/sdk.js";

const TRAILING_SLASH = /\/$/u;

let observability;

/** Call once, before the first LanguageModel call: the SDK patches LanguageModel when it starts. */
export async function startTracing() {
  observability = new BuiltInAIObservability({
    // Judges and the trace UI need the prompt and answer text. Off by default in the SDK.
    captureInput: true,
    captureOutput: true,
    includeMlflowPreview: true,
    // MLflow ingests OTLP and files traces under the experiment named in this header.
    otlpHeaders: { "x-mlflow-experiment-id": String(experimentId) },
    otlpUrl: `${settings.trackingUri.replace(TRAILING_SLASH, "")}/v1/traces`,
    serviceName: "mlflow-eval-example",
  });
  await observability.start();
}

/**
 * The full trace (info + spans) the SDK exported for one agent run: the trace whose request is
 * `question`, started after `since` (a Date.now() taken just before the run).
 */
export function findTrace(question, since) {
  return client.findTrace({
    experimentId,
    flush: () => observability?.flush(),
    question,
    since,
  });
}
