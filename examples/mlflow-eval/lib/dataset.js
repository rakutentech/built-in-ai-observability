// Reads the evaluation dataset back from MLflow (step 3 creates it).

import { client, DATASET_NAME, experimentId } from "../config.js";

/** Records of one split ("train" or "test"), or all of them. The split is our own tag. */
export async function loadRecords(split = "all") {
  const dataset = await client.findDataset(DATASET_NAME, experimentId);
  if (!dataset) {
    throw new Error(
      `Dataset ${DATASET_NAME} not found in experiment ${experimentId}: run step 3 first`
    );
  }
  const records = await client.getRecords(dataset.dataset_id);
  return split === "all"
    ? records
    : records.filter((record) => record.tags?.split === split);
}
