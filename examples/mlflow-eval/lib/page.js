// Page wiring only: connects the buttons in index.html to the numbered steps. The interesting code
// is in the steps (01_… to 06_…), not here.

import { run as registerPrompt } from "../01-register-prompt.js";
import { run as runAgent } from "../02-run-agent.js";
import { run as createDataset } from "../03-create-dataset.js";
import { run as evaluate } from "../04-evaluate.js";
import { run as optimize } from "../05-optimize.js";
import { run as compare } from "../06-compare.js";
import { AGENT_MODEL_OPTIONS, toolUseSupported } from "../agent.js";
import {
  DATASET_NAME,
  experimentId,
  PROMPT_NAME,
  saveSettings,
  settings,
} from "../config.js";
import { JUDGE_MODEL_OPTIONS } from "../scorers.js";
import { log } from "./output.js";
import { REWRITER_MODEL_OPTIONS } from "./rewriter.js";
import { startTracing } from "./tracing.js";

const $ = (selector) => document.querySelector(selector);
const value = (selector) => $(selector).value.trim();

// ---------- settings ----------

for (const key of ["trackingUri", "uiUri", "experimentId"]) {
  $(`#${key}`).value = settings[key];
}
$("#save").onclick = () => {
  saveSettings({
    experimentId: value("#experimentId"),
    trackingUri: value("#trackingUri"),
    uiUri: value("#uiUri"),
  });
  location.reload();
};

// Before anything uses LanguageModel: the SDK patches it when it starts.
await startTracing();

// ---------- is the on-device model ready? ----------

async function checkModel() {
  if (!("LanguageModel" in globalThis)) {
    $("#model-status").textContent =
      "LanguageModel is not available in this browser (Chrome with the Prompt API is required).";
    return;
  }
  if (!toolUseSupported()) {
    $("#model-status").textContent =
      "The Prompt API is here but tool use is not: enable Chrome's Prompt API tool-use flag.";
    return;
  }
  // availability() gets the same options as create(): the answer is per configuration.
  const [agent, judge, rewriter] = await Promise.all([
    LanguageModel.availability(AGENT_MODEL_OPTIONS),
    LanguageModel.availability(JUDGE_MODEL_OPTIONS),
    LanguageModel.availability(REWRITER_MODEL_OPTIONS),
  ]);
  $("#model-status").textContent =
    `On-device model: agent config ${agent}, judge config ${judge}, rewriter config ${rewriter}.`;
  const ready = [agent, judge, rewriter].every((s) => s === "available");
  $("#prepare").hidden = ready || agent === "unavailable";
}

$("#prepare").onclick = async () => {
  // create() starts the download; it needs a user gesture, which this click is.
  const progress = $("#download");
  progress.hidden = false;
  const session = await LanguageModel.create({
    ...AGENT_MODEL_OPTIONS,
    monitor: (m) =>
      m.addEventListener("downloadprogress", (e) => {
        progress.value = e.loaded;
        progress.max = e.total || 1;
      }),
  });
  session.destroy();
  progress.hidden = true;
  await checkModel();
};

await checkModel();
log(
  `MLflow ${settings.trackingUri}, experiment ${experimentId}. Prompt "${PROMPT_NAME}", dataset "${DATASET_NAME}".`
);

// ---------- one button per step ----------

const steps = {
  ask: () => runAgent({ question: value("#question") }),
  compare: () => compare({ version: value("#cmpVersion") }),
  dataset: () => createDataset(),
  evaluate: () =>
    evaluate({ split: value("#evalSplit"), version: value("#evalVersion") }),
  async optimize() {
    const { registered } = await optimize({
      rounds: Number(value("#optRounds")) || 2,
      version: value("#optVersion"),
    });
    if (registered) {
      // Step 6 compares the version we started from with the new one.
      $("#cmpVersion").value = value("#optVersion");
    }
  },
  register: () => registerPrompt(),
};

function setBusy(busy) {
  for (const button of document.querySelectorAll("[data-step]")) {
    button.disabled = busy;
  }
}

// One listener for every step button. One step runs at a time: there is one on-device model.
document.addEventListener("click", async (event) => {
  const button = event.target.closest?.("[data-step]");
  if (!button || button.disabled) {
    return;
  }
  setBusy(true);
  try {
    await steps[button.dataset.step]();
  } catch (err) {
    log(`Error: ${err.message}`);
    console.error(err);
  } finally {
    setBusy(false);
  }
});
