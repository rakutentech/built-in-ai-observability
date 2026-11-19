// Step 4: evaluate one prompt version on the dataset.
//
// Evaluating means: run the agent on every question, then let scorers grade each answer. The
// scorers (scorers.js) are one code check and two LLM judges. The result is an "evaluation run" in
// MLflow, with one score per question and scorer, plus the average of each.
//
// Do this for version 1 to get your baseline. Do it again after optimizing (step 5) to see
// whether the new prompt is better.

import { createAgent } from "./agent.js";
import { client, MODEL_NAME, promptUri, uiLinks } from "./config.js";
import { loadRecords } from "./lib/dataset.js";
import { evaluate } from "./lib/evaluate.js";
import { log, showResults } from "./lib/output.js";
import { SCORERS } from "./scorers.js";

/** `version` is a prompt version number or "latest"; `split` is "train", "test" or "all". */
export async function run({ version, split }) {
  const prompt = await client.loadPrompt(promptUri(version));
  const records = await loadRecords(split);

  const agent = await createAgent(prompt);
  let result;
  try {
    result = await evaluate({
      params: {
        agent_model: MODEL_NAME,
        judge_model: MODEL_NAME,
        prompt_uri: prompt.uri,
        split,
      },
      // How to get an answer for one record: ask the agent the record's question.
      predictFn: ({ question }) => agent.run(question),
      prompt,
      records,
      runName: `browser-eval-prompt-v${prompt.version}-${split}`,
      scorers: SCORERS,
      // Tags on each trace, so you can find them in the MLflow UI.
      traceTags: { "eval.split": split, "prompt.uri": prompt.uri },
    });
  } finally {
    agent.destroy();
  }

  log(`v${prompt.version} on ${split}: ${JSON.stringify(result.metrics)}`, {
    href: uiLinks.evalRuns(),
    label: "evaluation runs",
  });
  showResults(result.rows, SCORERS);
  return { version: prompt.version, ...result };
}
