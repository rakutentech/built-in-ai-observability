// Step 1: register the baseline system prompt (version 1) in MLflow's Prompt Registry.
//
// A prompt registry keeps every version of your prompt text, so you can change it, compare
// versions and roll back without touching code. The agent (agent.js) loads its system prompt from
// here, and that is what lets the optimizer in step 5 swap in a better one.

import { client, experimentId, PROMPT_NAME, uiLinks } from "./config.js";
import { log } from "./lib/output.js";

// Deliberately minimal, so there is something to improve later.
const BASELINE_TEMPLATE =
  "You are a customer support assistant for an online store.";

export async function run() {
  // Each call registers a new version of the same prompt.
  const prompt = await client.registerPrompt({
    commitMessage: "Baseline: deliberately minimal prompt",
    experimentId,
    name: PROMPT_NAME,
    template: BASELINE_TEMPLATE,
  });
  log(`Registered ${prompt.name} version ${prompt.version} -> ${prompt.uri}`, {
    href: uiLinks.prompt(PROMPT_NAME),
    label: "open in MLflow",
  });
}
