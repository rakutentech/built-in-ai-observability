// The browser version of mlflow.genai.evaluate(data, predict_fn, scorers).
//
// What Python's evaluate() does, and what this does with REST calls:
//   1. create a run tagged mlflow.runType=genai_evaluate      -> it shows under "Evaluation runs"
//   2. for each record: predict_fn(**inputs), which produces a trace
//   3. log the record's expectations and each scorer's feedback on that trace, tagged with the
//      run ID (assessment metadata mlflow.assessment.sourceRunId)
//   4. link the traces to the run, log "<scorer>/mean" metrics, end the run
// Records run one at a time: there is one on-device model and it does one thing at a time.

import { client, experimentId } from "../config.js";
import { toNumber } from "../scorers.js";
import { log } from "./output.js";
import { findTrace } from "./tracing.js";

const LINK_BATCH_SIZE = 100;

/**
 * Runs the agent and the scorers over the records, without creating a run. evaluate() uses it, and
 * so does the optimizer, which scores candidate prompts that are not registered yet.
 *
 * predictFn(inputs) must resolve to { answer, startedAt, ... } (see createAgent). The agent's trace
 * is found afterwards by question and start time, then `traceTags` are set on it and the loaded
 * `prompt`, if any, is linked to it. Resolves to { rows, metrics }.
 */
export async function scoreRecords({
  records,
  predictFn,
  scorers,
  prompt,
  traceTags = {},
  runId,
  indent = "",
}) {
  const say = (text) => log(`${indent}${text}`);
  const rows = [];
  for (const [index, record] of records.entries()) {
    const { inputs, expectations = {} } = record;
    say(`[${index + 1}/${records.length}] ${inputs.question}`);
    const row = { expectations, inputs, scores: {} };
    rows.push(row);
    try {
      row.output = await predictFn(inputs);
      say(`   → ${row.output.answer}`);

      const trace = await findTrace(inputs.question, row.output.startedAt);
      const { trace_id: traceId } = trace.trace_info;
      row.traceId = traceId;
      await client.setTraceTags(traceId, traceTags);
      if (prompt?.uri) {
        await client.linkPromptToTrace(traceId, prompt);
      }

      // The ground truth, shown next to the scores in the MLflow UI.
      for (const [name, value] of Object.entries(expectations)) {
        await client.logExpectation({ name, runId, traceId, value });
      }
      for (const scorer of scorers) {
        let feedback;
        try {
          feedback = await scorer.score({
            expectations,
            inputs,
            outputs: row.output,
            trace,
          });
        } catch (err) {
          // A judge failure is not an agent failure: leave it out of the mean, like MLflow does.
          say(`   ${scorer.name}: scorer error: ${err.message}`);
          continue;
        }
        row.scores[scorer.name] = feedback;
        say(`   ${scorer.name}: ${feedback.value}`);
        await client.logFeedback({
          name: scorer.name,
          traceId,
          ...feedback,
          runId,
          source: scorer.source,
        });
      }
    } catch (err) {
      // The agent itself failed: every scorer fails this row.
      row.error = String(err.message ?? err);
      say(`   agent error: ${row.error}`);
      for (const scorer of scorers) {
        row.scores[scorer.name] = {
          rationale: `agent error: ${row.error}`,
          value: false,
        };
      }
    }
  }
  return { metrics: aggregate(rows, scorers), rows };
}

/** Mean of each scorer over the rows, as "<name>/mean", plus "score" = mean of those means. */
export function aggregate(rows, scorers) {
  const metrics = {};
  for (const { name } of scorers) {
    const values = rows
      .map((row) => row.scores[name])
      .filter(Boolean)
      .map((feedback) => toNumber(feedback.value));
    if (values.length) {
      metrics[`${name}/mean`] =
        values.reduce((a, b) => a + b, 0) / values.length;
    }
  }
  const means = Object.values(metrics);
  metrics.score = means.length
    ? means.reduce((a, b) => a + b, 0) / means.length
    : 0;
  return metrics;
}

/** Links traces to a run, in batches (the endpoint takes a limited number at a time). */
export async function linkTraces(runId, traceIds) {
  for (let i = 0; i < traceIds.length; i += LINK_BATCH_SIZE) {
    await client.linkTracesToRun(runId, traceIds.slice(i, i + LINK_BATCH_SIZE));
  }
}

/** Evaluates and logs the result as an MLflow evaluation run. Resolves to { metrics, rows, runId }. */
export async function evaluate({
  records,
  predictFn,
  scorers,
  prompt,
  traceTags,
  runName,
  params = {},
}) {
  const runId = await client.createRun({
    experimentId,
    runName,
    tags: {
      "mlflow.runType": "genai_evaluate",
      "mlflow.source.name": "browser/evaluate.js",
    },
  });
  log(`Evaluation run ${runName} (${runId})`);
  try {
    await client.logParams(runId, params);
    const { rows, metrics } = await scoreRecords({
      predictFn,
      prompt,
      records,
      runId,
      scorers,
      traceTags,
    });
    await linkTraces(runId, rows.map((row) => row.traceId).filter(Boolean));
    const { score, ...perScorer } = metrics;
    await client.logMetrics(runId, perScorer);
    await client.endRun(runId);
    return { metrics, rows, runId };
  } catch (err) {
    await client.endRun(runId, "FAILED");
    throw err;
  }
}
