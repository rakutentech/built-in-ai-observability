// Step 2: run the agent once and look at its trace.
//
// A trace is the recording of one request: every model call and every tool call, with inputs,
// outputs and timings. You do not add any tracing code here. The SDK started in lib/tracing.js
// watches the Prompt API and sends the trace to MLflow by itself.

import { createAgent } from "./agent.js";
import { client, promptUri, uiLinks } from "./config.js";
import { log } from "./lib/output.js";
import { findTrace } from "./lib/tracing.js";

export async function run({ question }) {
  // "@latest" is the newest version in the registry.
  const prompt = await client.loadPrompt(promptUri("latest"));
  log(`> ${question}   (system prompt ${prompt.uri})`);

  const agent = await createAgent(prompt);
  let answer;
  try {
    answer = await agent.run(question, { onStep: log });
  } finally {
    agent.destroy();
  }

  // Wait for the trace to arrive in MLflow, then show its spans, like a tree.
  const trace = await findTrace(question, answer.startedAt);
  const traceId = trace.trace_info.trace_id;
  await client.linkPromptToTrace(traceId, prompt);
  log(answer.answer, {
    href: uiLinks.trace(traceId),
    label: `trace ${traceId}`,
  });
  log("Spans in the trace:");
  for (const { depth, name } of spanTree(trace.spans)) {
    log(`${"  ".repeat(depth + 1)}${name}`);
  }
}

/** The spans of a trace in order, each with how deep it is in the tree. */
function spanTree(spans) {
  const depthOf = (span) => {
    const parent = spans.find((s) => s.span_id === span.parent_span_id);
    return parent ? depthOf(parent) + 1 : 0;
  };
  return spans.map((span) => ({ depth: depthOf(span), name: span.name }));
}
