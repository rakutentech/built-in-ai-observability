// Step 3: create an evaluation dataset: questions plus what a good answer looks like.
//
// To know whether a prompt is good you need examples with known right answers. Each record has:
//   inputs        what we ask the agent. The key (`question`) matches what the agent takes.
//   expectations  the ground truth that the scorers (scorers.js) compare the agent against:
//                 expected_facts -> what the answer must say, read by the correctness judge
//                 expected_tools -> which tools the agent must call, read by uses_right_tools
//   tags.split    "train" rows are for the optimizer to learn from (step 5). "test" rows are
//                 held back to check that an improvement is real (step 6).

import { client, DATASET_NAME, experimentId } from "./config.js";
import { log } from "./lib/output.js";

const RECORDS = [
  {
    expectedFacts: ["The order has shipped", "It arrives in 2 days"],
    expectedTools: ["get_order_status"],
    question: "Where is my order A101?",
    split: "train",
  },
  {
    expectedFacts: [
      "Yes, it is eligible",
      "Delivered 12 days ago, within the 30-day window",
    ],
    expectedTools: ["get_order_status", "get_return_policy"],
    question: "Can I return order A100?",
    split: "train",
  },
  {
    expectedFacts: [
      "No, it is not eligible",
      "Delivered 45 days ago, past the 30-day window",
    ],
    expectedTools: ["get_order_status", "get_return_policy"],
    question: "Can I return order A102?",
    split: "train",
  },
  {
    expectedFacts: [
      "The return cannot be started",
      "Delivered 70 days ago, past the 60-day window",
    ],
    expectedTools: ["get_order_status", "get_return_policy"],
    question: "I want to return order A103, please start the return.",
    split: "train",
  },
  {
    expectedFacts: ["The return was started", "The RMA id is RMA-A100"],
    expectedTools: ["get_order_status", "get_return_policy", "start_return"],
    question: "Please start a return for order A100.",
    split: "train",
  },
  {
    expectedFacts: ["The return window for apparel is 60 days"],
    expectedTools: ["get_return_policy"],
    question: "What is the return window for apparel?",
    split: "train",
  },
  {
    expectedFacts: ["Order Z999 was not found"],
    expectedTools: ["get_order_status"],
    question: "What is the status of order Z999?",
    split: "train",
  },
  {
    expectedFacts: ["The price was $1299.00", "It has been delivered"],
    expectedTools: ["get_order_status"],
    question: "How much did I pay for order A104 and has it arrived?",
    split: "test",
  },
  {
    expectedFacts: [
      "Yes, it is eligible",
      "Delivered 5 days ago, within the 30-day window",
    ],
    expectedTools: ["get_order_status", "get_return_policy"],
    question: "Can I return the laptop from order A104?",
    split: "test",
  },
  {
    expectedFacts: [
      "The order has not been delivered yet",
      "It cannot be returned until it arrives",
    ],
    expectedTools: ["get_order_status"],
    question: "Can I return order A101 yet?",
    split: "test",
  },
];

export async function run() {
  const existing = await client.findDataset(DATASET_NAME, experimentId);
  if (existing) {
    log(
      `Dataset ${DATASET_NAME} already exists (${existing.dataset_id}); delete it in the MLflow UI to recreate it`
    );
  } else {
    const dataset = await client.createDataset({
      experimentId,
      name: DATASET_NAME,
      tags: { purpose: "built-in-ai-observability example" },
    });
    await client.upsertRecords(
      dataset.dataset_id,
      RECORDS.map((r) => ({
        expectations: {
          expected_facts: r.expectedFacts,
          expected_tools: r.expectedTools,
        },
        inputs: { question: r.question },
        tags: { split: r.split },
      }))
    );
    log(`Created dataset ${dataset.name} (${dataset.dataset_id})`);
  }

  const dataset = await client.findDataset(DATASET_NAME, experimentId);
  const records = await client.getRecords(dataset.dataset_id);
  // Train rows first.
  records.sort((a, b) => b.tags.split.localeCompare(a.tags.split));
  for (const r of records) {
    log(`  [${r.tags.split}] ${r.inputs.question}`);
  }
}
