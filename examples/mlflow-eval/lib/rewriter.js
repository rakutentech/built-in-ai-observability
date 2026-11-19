// The "reflection model" of the optimizer: reads the failures and writes a better system prompt.
// It is the same on-device model as the agent, asked to act as a prompt engineer.

import { TOOL_DECLARATIONS } from "../tools.js";

/**
 * The agent and the judges run "most-predictable" so scores are comparable between runs. The
 * rewriter needs the opposite: a deterministic rewriter given the same failures writes the same
 * prompt every round (we measured ten identical candidates), so a round teaches nothing. It also
 * gets a fresh session each round: a clone replays its parent's sampling, so cloning would repeat
 * the same rewrite even at "balanced".
 */
export const REWRITER_MODEL_OPTIONS = {
  expectedInputs: [{ languages: ["en"], type: "text" }],
  expectedOutputs: [{ languages: ["en"], type: "text" }],
  samplingMode: "balanced",
};

const REWRITE_SCHEMA = {
  properties: { analysis: { type: "string" }, prompt: { type: "string" } },
  required: ["analysis", "prompt"],
  type: "object",
};

const MAX_FAILURES_SHOWN = 5;
const MAX_REJECTED_SHOWN = 2;

const clip = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

const failedChecks = (row) =>
  Object.entries(row.scores).filter(
    ([, feedback]) => feedback.value === false || feedback.value === "no"
  );

/** Kept short on purpose: the on-device model's context window is a few thousand tokens. */
function metaPrompt(template, rows, rejected) {
  const failures = rows
    .filter((row) => failedChecks(row).length > 0)
    .slice(0, MAX_FAILURES_SHOWN)
    .map((row) => {
      const failed = failedChecks(row)
        .map(([name, f]) => `  - ${name}: ${clip(f.rationale, 250)}`)
        .join("\n");
      const answer = clip(row.output?.answer ?? row.error, 300);
      return `<example>\nQuestion: ${row.inputs.question}\nAnswer: ${answer}\nFailed checks:\n${failed}\n</example>`;
    })
    .join("\n");
  const tools = TOOL_DECLARATIONS.map(
    (t) => `- ${t.name}: ${t.description}`
  ).join("\n");
  const tried = rejected
    .slice(-MAX_REJECTED_SHOWN)
    .map(
      (r) =>
        `<rejected score="${r.score.toFixed(2)}">${clip(r.template, 600)}</rejected>`
    )
    .join("\n");
  const triedSection = tried
    ? `\nThese rewrites were already tried and did NOT score better. Do not repeat them; take a different approach:\n${tried}\n`
    : "";

  return `You are an expert prompt engineer. Improve the system prompt of a customer support agent for an online store. The agent answers customer questions and can call these tools:
${tools}

CURRENT SYSTEM PROMPT:
<prompt>${template}</prompt>

The agent failed these checks with the current prompt:
${failures}
${triedSection}
Write an improved system prompt that fixes the causes of these failures. Rules:
- Give general instructions. Do not mention specific order IDs, products or questions from the examples.
- Be explicit about which tools to call and when, and about the format and length of answers.
- Tell the agent to call a tool rather than ask the customer for something a tool can look up.
- Keep it under 150 words. Do not add {{...}} placeholders.

In "analysis", explain briefly what went wrong. In "prompt", give only the new system prompt.`;
}

/**
 * Asks for a better prompt. `rows` are the scored rows of `template` (see scoreRecords) and
 * `rejected` the earlier rewrites that did not help, as [{template, score}].
 * Resolves to { analysis, prompt }.
 */
export async function rewrite(template, rows, rejected) {
  const session = await LanguageModel.create(REWRITER_MODEL_OPTIONS);
  try {
    const raw = await session.prompt(metaPrompt(template, rows, rejected), {
      responseConstraint: REWRITE_SCHEMA,
    });
    return JSON.parse(raw);
  } finally {
    session.destroy();
  }
}
