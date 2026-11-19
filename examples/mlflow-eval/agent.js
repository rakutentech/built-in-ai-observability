// The agent under test: the on-device model (Gemma 4 in Chrome Canary) plus three tools, with its
// system prompt loaded from the MLflow Prompt Registry.
//
// Nothing here is traced by hand. The SDK started in lib/tracing.js instruments the Prompt API,
// so every question shows up in MLflow as a trace with one span per model call and tool call.

import { readAssistantTurn } from "./dist/sdk.js";
import { TOOL_DECLARATIONS, TOOLS_BY_NAME } from "./tools.js";

const MAX_TOOL_ROUNDS = 5;

/**
 * Passed as-is to both LanguageModel.availability() and LanguageModel.create(), so the
 * availability answer is about this exact configuration (tools, modalities, language).
 */
export const AGENT_MODEL_OPTIONS = {
  expectedInputs: [
    { languages: ["en"], type: "text" },
    { type: "tool-response" },
    { type: "tool-call" },
  ],
  expectedOutputs: [{ languages: ["en"], type: "text" }, { type: "tool-call" }],
  // Closest thing to temperature=0, so repeated evaluations are comparable.
  samplingMode: "most-predictable",
  tools: TOOL_DECLARATIONS,
};

/** Tool calls in the Prompt API need Chrome's tool-use flag; these classes appear with it. */
export const toolUseSupported = () =>
  "LanguageModelToolCall" in globalThis &&
  "LanguageModelToolSuccess" in globalThis;

/** Runs one tool the model asked for and wraps the outcome the way the Prompt API expects. */
async function runTool(call) {
  // The browser calls the id `callId`; the response must carry the same one.
  const callId = call.id;
  const tool = TOOLS_BY_NAME.get(call.name);
  if (!tool) {
    return new LanguageModelToolError({
      callId,
      errorMessage: `No tool named ${call.name}`,
      name: call.name,
    });
  }
  try {
    const args =
      typeof call.arguments === "string"
        ? JSON.parse(call.arguments)
        : (call.arguments ?? {});
    return new LanguageModelToolSuccess({
      callId,
      name: call.name,
      result: [{ type: "object", value: await tool.execute(args) }],
    });
  } catch (err) {
    return new LanguageModelToolError({
      callId,
      errorMessage: err instanceof Error ? err.message : String(err),
      name: call.name,
    });
  }
}

/**
 * An agent for one system prompt. `prompt` is a prompt version loaded from the registry, or (while
 * optimizing) a candidate with only a `template`. Call destroy() when done.
 *
 * The session holding the system prompt and the tool declarations is built once. Every question
 * then runs in a clone of it, which:
 *   - starts each question from the same state, so nothing leaks from one question to the next;
 *   - is fast (about 1 ms where create() took about 400 ms in Chrome Canary);
 *   - keeps the sampling mode. "most-predictable" is what we want here (comparable runs). When you
 *     want variety, use a fresh create() instead (see lib/rewriter.js).
 * The base session is never prompted itself, so it stays a clean template.
 *
 * run(question) resolves to { answer, toolCalls, startedAt }. `startedAt` is when the question was
 * sent, which lib/tracing.js uses to find the trace afterwards.
 */
export async function createAgent(prompt) {
  const systemPrompt = prompt.format ? prompt.format() : prompt.template;
  const base = await LanguageModel.create({
    ...AGENT_MODEL_OPTIONS,
    initialPrompts: [{ content: systemPrompt, role: "system" }],
  });

  return {
    destroy: () => base.destroy(),

    async run(question, { onStep = () => undefined } = {}) {
      const startedAt = Date.now();
      const session = await base.clone();
      const toolCalls = [];
      try {
        // The tool loop: prompt the model; if it asks for tools, run them and send the results back.
        let input = question;
        for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
          const turn = readAssistantTurn(await session.prompt(input));
          if (turn.toolCalls.length === 0) {
            return { answer: turn.text.trim(), startedAt, toolCalls };
          }
          const responses = [];
          for (const call of turn.toolCalls) {
            toolCalls.push({ arguments: call.arguments, name: call.name });
            onStep(`⚙ ${call.name}(${JSON.stringify(call.arguments ?? {})})`);
            responses.push({
              type: "tool-response",
              value: await runTool(call),
            });
          }
          input = [{ content: responses, role: "user" }];
        }
        return {
          answer: `(stopped after ${MAX_TOOL_ROUNDS} tool rounds)`,
          startedAt,
          toolCalls,
        };
      } finally {
        session.destroy();
      }
    },
  };
}
