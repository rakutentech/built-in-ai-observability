// Step 5: let the model rewrite the system prompt, keeping the rewrites that score better.
//
// This is a small version of what MLflow's optimizers (GEPA, MetaPrompt) do in Python:
//
//   1. Score the current prompt on the train split.
//   2. Show the model the questions it failed, with the scorers' reasons, and ask for a better
//      prompt (lib/rewriter.js).
//   3. Score the new prompt. Keep it if it beats the best so far.
//   4. Repeat for a few rounds, then register the best prompt as a new version.
//
// Only the train split is used. Step 6 checks the result on the test split, which the optimizer
// never saw. Every candidate is scored on the same rows it was tuned on, so its train score is
// optimistic.

import { createAgent } from "./agent.js";
import {
  client,
  experimentId,
  MODEL_NAME,
  promptUri,
  uiLinks,
} from "./config.js";
import { loadRecords } from "./lib/dataset.js";
import { linkTraces, scoreRecords } from "./lib/evaluate.js";
import { log } from "./lib/output.js";
import { rewrite } from "./lib/rewriter.js";
import { SCORERS } from "./scorers.js";

/** `version` is the prompt version to start from. */
export async function run({ version, rounds }) {
  const prompt = await client.loadPrompt(promptUri(version));
  const trainRecords = await loadRecords("train");

  // One MLflow run holds the whole optimization: parameters, a score per round, all the traces.
  const runId = await client.createRun({
    experimentId,
    runName: `optimize-${prompt.name}-v${prompt.version}`,
    tags: { "mlflow.source.name": "browser/optimize.js" },
  });
  await client.logParams(runId, {
    reflection_model: MODEL_NAME,
    rounds,
    source_prompt: prompt.uri,
    train_rows: trainRecords.length,
  });

  const traceIds = [];
  /** Runs the agent with this prompt text on every train row and scores it. */
  const score = async (template, label) => {
    log(`— scoring ${label} on ${trainRecords.length} train rows`);
    const agent = await createAgent({ template });
    try {
      const result = await scoreRecords({
        indent: "  ",
        predictFn: ({ question }) => agent.run(question),
        records: trainRecords,
        runId,
        scorers: SCORERS,
        traceTags: { "eval.candidate": label, "eval.phase": "optimize" },
      });
      traceIds.push(...result.rows.map((row) => row.traceId).filter(Boolean));
      log(`  ${label}: score ${result.metrics.score.toFixed(3)}`);
      return result;
    } finally {
      agent.destroy();
    }
  };

  try {
    // 1. The starting point.
    const initial = await score(prompt.template, `v${prompt.version}`);
    await client.logMetrics(
      runId,
      { candidate_score: initial.metrics.score },
      0
    );

    let best = { template: prompt.template, ...initial };
    const tried = new Set([prompt.template.trim()]);
    const rejected = []; // rewrites that did not beat the best; shown to the model so it varies

    for (let round = 1; round <= rounds; round += 1) {
      // 2. Ask for a better prompt, based on how the best one failed.
      log(`Round ${round}: asking the model for a better prompt`);
      const { analysis, prompt: candidate } = await rewrite(
        best.template,
        best.rows,
        rejected
      );
      log(`  analysis: ${analysis}`);
      log(`  candidate:\n${candidate}`);
      if (tried.has(candidate.trim())) {
        log("  Same prompt as one already scored; skipping it.");
        continue;
      }
      tried.add(candidate.trim());

      // 3. Score it and keep the best.
      const result = await score(candidate, `candidate-${round}`);
      await client.logMetrics(
        runId,
        { candidate_score: result.metrics.score },
        round
      );
      if (result.metrics.score > best.metrics.score) {
        best = { template: candidate, ...result };
      } else {
        rejected.push({ score: result.metrics.score, template: candidate });
      }
    }

    await linkTraces(runId, traceIds);
    await client.logMetrics(runId, {
      final_score: best.metrics.score,
      initial_score: initial.metrics.score,
    });

    // 4. Register the winner as a new prompt version, if there is one.
    let registered = null;
    if (best.template === prompt.template) {
      log(
        "No candidate beat the starting prompt; nothing registered. Try more rounds."
      );
    } else {
      registered = await client.registerPrompt({
        commitMessage: `Optimized in the browser from v${prompt.version}: train score ${initial.metrics.score.toFixed(3)} → ${best.metrics.score.toFixed(3)}`,
        experimentId,
        name: prompt.name,
        template: best.template,
      });
      log(`Registered ${registered.uri}`);
    }
    await client.endRun(runId);

    log(
      `Train score ${initial.metrics.score.toFixed(3)} → ${best.metrics.score.toFixed(3)}`,
      { href: uiLinks.run(runId), label: "optimization run" }
    );
    return { registered };
  } catch (err) {
    await client.endRun(runId, "FAILED");
    throw err;
  }
}
