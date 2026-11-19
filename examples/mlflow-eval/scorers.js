// Scorers: the checks that turn an agent's answer into a pass or a fail.
//
// - uses_right_tools: plain code that reads the trace back from MLflow.
// - correctness, concise: LLM judges. The prompts are MLflow's own Correctness and Guidelines
//   judge prompts (mlflow/genai/judges/prompts/), run on the on-device model with a JSON
//   responseConstraint instead of a hosted model.
//
// A scorer is { name, source, score({inputs, outputs, expectations, trace}) -> {value, rationale} }.
// `value` is true/false or "yes"/"no"; `rationale` says why.

import { MODEL_NAME } from "./config.js";
import { spanAttributes } from "./lib/mlflow-client.js";

/** Same options for availability() and create(). Plain text in, constrained JSON out. */
export const JUDGE_MODEL_OPTIONS = {
  expectedInputs: [{ languages: ["en"], type: "text" }],
  expectedOutputs: [{ languages: ["en"], type: "text" }],
  samplingMode: "most-predictable",
};
const PLACEHOLDER = /\{\{(?<key>\w+)\}\}/gu;
const JUDGE_SOURCE_ID = `chrome-prompt-api/${MODEL_NAME}`;

const VERDICT_SCHEMA = {
  // Rationale first: the model reasons before it commits to a verdict.
  properties: {
    rationale: { type: "string" },
    result: { enum: ["yes", "no"], type: "string" },
  },
  required: ["rationale", "result"],
  type: "object",
};

/**
 * Asks the on-device model for a yes/no verdict. One fresh session per verdict, so a judge never
 * sees earlier rows. The agent clones a primed session instead (see createAgent) because its
 * system prompt and tools are worth building once; a judge's prompt is all per-row content.
 */
export async function judge(prompt) {
  const session = await LanguageModel.create(JUDGE_MODEL_OPTIONS);
  try {
    const raw = await session.prompt(prompt, {
      responseConstraint: VERDICT_SCHEMA,
    });
    const { result, rationale } = JSON.parse(raw);
    return { rationale, value: result };
  } finally {
    session.destroy();
  }
}

// ---- uses_right_tools: code scorer over the trace ----

export const usesRightTools = {
  name: "uses_right_tools",
  score({ trace, expectations }) {
    // The SDK names tool spans "execute_tool <name>" and sets gen_ai.tool.name.
    const called = new Set(
      trace.spans
        .map((span) => spanAttributes(span)["gen_ai.tool.name"])
        .filter(Boolean)
    );
    const expected = new Set(expectations.expected_tools ?? []);
    const missing = [...expected].filter((tool) => !called.has(tool));
    const unwantedReturn =
      called.has("start_return") && !expected.has("start_return");
    return {
      rationale:
        `called=${JSON.stringify([...called].sort())} expected=${JSON.stringify([...expected].sort())} ` +
        `missing=${JSON.stringify(missing)} unwanted_start_return=${unwantedReturn}`,
      value: missing.length === 0 && !unwantedReturn,
    };
  },
  source: { source_id: "uses_right_tools", source_type: "CODE" },
};

// ---- correctness: MLflow's Correctness judge prompt, with expected_facts ----

const CORRECTNESS_PROMPT = `Consider the following question, claim and document. You must determine whether the claim is supported by the document in the context of the question. Do not focus on the correctness or completeness of the claim. Do not make assumptions, approximations, or bring in external knowledge.

<question>{{input}}</question>
<claim>{{ground_truth}}</claim>
<document>{{input}} - {{output}}</document>

The result is "yes" if every statement in the claim is supported by the document in the context of the question, and "no" otherwise.

If the claim is fully supported by the document in the context of the question, you must say "The response is correct" in the rationale. If the claim is not fully supported by the document in the context of the question, you must say "The response is not correct".`;

export const correctness = {
  name: "correctness",
  score({ inputs, outputs, expectations }) {
    const groundTruth = (expectations.expected_facts ?? [])
      .map((fact) => `\n- ${fact}`)
      .join("");
    return judge(
      fill(CORRECTNESS_PROMPT, {
        ground_truth: groundTruth,
        input: inputs.question,
        output: outputs.answer,
      })
    );
  },
  source: { source_id: JUDGE_SOURCE_ID, source_type: "LLM_JUDGE" },
};

// ---- concise: MLflow's Guidelines judge prompt ----

const GUIDELINES_PROMPT = `Given the following set of guidelines and some inputs, please assess whether the inputs fully comply with all the provided guidelines. Only focus on the provided guidelines and not the correctness, relevance, or effectiveness of the inputs.

<guidelines>
{{guidelines}}
</guidelines>
{{guidelines_context}}

The result is "no" if any guideline is not satisfied. The result is "yes" if all guidelines are satisfied or none of them apply to the inputs.`;

export function guidelines(name, rules) {
  return {
    name,
    score({ inputs, outputs }) {
      return judge(
        fill(GUIDELINES_PROMPT, {
          guidelines: rules
            .map((rule) => `<guideline>${rule}</guideline>`)
            .join("\n"),
          guidelines_context: `<request>${inputs.question}</request>\n<response>${outputs.answer}</response>`,
        })
      );
    },
    source: { source_id: JUDGE_SOURCE_ID, source_type: "LLM_JUDGE" },
  };
}

export const concise = guidelines("concise", [
  "The response must be at most 3 sentences.",
  "The response must be plain text with no markdown (no bullet points, bold or headings).",
]);

export const SCORERS = [usesRightTools, correctness, concise];

/** yes/true -> 1, no/false -> 0, the same way MLflow averages them into "<name>/mean". */
export function toNumber(value) {
  if (value === true || value === "yes") {
    return 1;
  }
  if (value === false || value === "no") {
    return 0;
  }
  return Number(value);
}

function fill(template, values) {
  return template.replace(PLACEHOLDER, (_, key) => String(values[key] ?? ""));
}
