// Shared setup: where MLflow is, which experiment to use, and what things are called.
// The URLs and the experiment can be edited on the page (they are saved in localStorage).

import { MlflowClient } from "./lib/mlflow-client.js";

const DEFAULTS = {
  // "0" is MLflow's Default experiment, which always exists.
  experimentId: "0",
  // The MLflow server the page calls: REST API and OTLP endpoint (`pnpm mlflow` serves :5000).
  trackingUri: "http://localhost:5000",
  // Where links open. The same server unless you run MLflow's UI dev server on another port.
  uiUri: "http://localhost:5000",
};

const STORAGE_KEY = "mlflow-eval-example.settings";

export const settings = {
  ...DEFAULTS,
  ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"),
};

export function saveSettings(values) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, ...values }));
}

export const { experimentId } = settings;
export const client = new MlflowClient(settings.trackingUri);

// Prompt names are global in MLflow (not per experiment); the dataset is linked to the experiment.
export const PROMPT_NAME = "prompt-api-support-agent";
export const DATASET_NAME = "prompt_api_support_agent_eval";

// The on-device model behind the Prompt API in Chrome Canary (see chrome://on-device-internals).
// Only used as a label in MLflow; the browser decides which model actually runs.
export const MODEL_NAME = "gemma-4";

/** "prompts:/<name>/3" for a version number, "prompts:/<name>@latest" for the newest one. */
export const promptUri = (version) =>
  version === "latest"
    ? `prompts:/${PROMPT_NAME}@latest`
    : `prompts:/${PROMPT_NAME}/${version}`;

export const uiLinks = {
  evalRuns: () =>
    `${settings.uiUri}/#/experiments/${experimentId}/evaluation-runs`,
  prompt: (name) => `${settings.uiUri}/#/prompts/${encodeURIComponent(name)}`,
  run: (runId) =>
    `${settings.uiUri}/#/experiments/${experimentId}/runs/${runId}`,
  trace: (traceId) =>
    `${settings.uiUri}/#/experiments/${experimentId}/traces?selectedEvaluationId=${traceId}`,
};
