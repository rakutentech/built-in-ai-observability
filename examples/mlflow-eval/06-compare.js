// Step 6: compare the old and the new prompt on data the optimizer never saw.
//
// The optimizer tuned the new prompt on the train split, so its train score proves little. The
// test split was held back: if the new prompt also wins there, the improvement is real. If it
// only wins on train, the optimizer memorised those examples (overfitting). With a handful of
// rows and a small model, expect some noise: run it again before trusting a small gain.

import { run as evaluate } from "./04-evaluate.js";
import { uiLinks } from "./config.js";
import { log } from "./lib/output.js";

/** `version` is the starting prompt version; it is compared with "latest". */
export async function run({ version }) {
  const before = await evaluate({ split: "test", version });
  const after = await evaluate({ split: "test", version: "latest" });
  log(
    `Test split: v${before.version} ${before.metrics.score.toFixed(3)} vs v${after.version} ${after.metrics.score.toFixed(3)}. ` +
      "Select both runs under Evaluation runs and click Compare.",
    { href: uiLinks.evalRuns(), label: "evaluation runs" }
  );
}
