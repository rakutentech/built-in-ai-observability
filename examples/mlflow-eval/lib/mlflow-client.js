// A tiny MLflow REST client: no dependencies, plain fetch(), runs in the browser and in Node.
//
// MLflow has no JS SDK for prompts, datasets or evaluation, but everything the Python
// `mlflow.genai` APIs do goes through these REST endpoints. The MLflow UI calls the same ones.

const IS_PROMPT_TAG = "mlflow.prompt.is_prompt";
const PROMPT_TEXT_TAG = "mlflow.prompt.text";
const PROMPT_TYPE_TAG = "_mlflow_prompt_type";
const PROMPT_EXPERIMENT_IDS_TAG = "_mlflow_experiment_ids";
// CreateModelVersion requires a source; prompt versions accept only this placeholder.
const PROMPT_SOURCE_PLACEHOLDER = "dummy-source";

export const SOURCE_RUN_ID_KEY = "mlflow.assessment.sourceRunId";

const CLOCK_SLACK_MS = 1000;
const TRAILING_SLASH = /\/$/u;
// prompts:/name/3, prompts:/name@alias, prompts:/name@latest
const PROMPT_URI =
  /^prompts:\/(?<name>[^/@]+)(?:\/(?<version>\d+)|@(?<alias>.+))$/u;
const TEMPLATE_VARIABLE = /\{\{\s*(?<key>[\w.]+)\s*\}\}/gu;

export class MlflowError extends Error {
  constructor(status, body) {
    super(`MLflow ${status}: ${body?.message ?? JSON.stringify(body)}`);
    this.status = status;
    this.errorCode = body?.error_code;
  }
}

export class MlflowClient {
  constructor(trackingUri) {
    this.base = trackingUri.replace(TRAILING_SLASH, "");
  }

  async call(method, path, body) {
    let url = `${this.base}/api/${path}`;
    const init = { headers: {}, method };
    if (body && method === "GET") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        for (const item of [value].flat()) {
          params.append(key, String(item));
        }
      }
      url += `?${params}`;
    } else if (body) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new MlflowError(res.status, json);
    }
    return json;
  }

  // ---------- Prompt Registry (prompts are registered models with prompt tags) ----------

  /** Same as mlflow.genai.register_prompt: creates the prompt if needed, then a new version. */
  async registerPrompt({ name, template, commitMessage, experimentId }) {
    try {
      await this.call("POST", "2.0/mlflow/registered-models/create", {
        name,
        tags: [
          { key: IS_PROMPT_TAG, value: "true" },
          // Lets the experiment's Prompts tab list it.
          ...(experimentId
            ? [{ key: PROMPT_EXPERIMENT_IDS_TAG, value: `,${experimentId},` }]
            : []),
        ],
      });
    } catch (err) {
      if (err.errorCode !== "RESOURCE_ALREADY_EXISTS") {
        throw err;
      }
    }
    const { model_version } = await this.call(
      "POST",
      "2.0/mlflow/model-versions/create",
      {
        description: commitMessage,
        name,
        source: PROMPT_SOURCE_PLACEHOLDER,
        tags: [
          { key: IS_PROMPT_TAG, value: "true" },
          { key: PROMPT_TEXT_TAG, value: template },
          { key: PROMPT_TYPE_TAG, value: "text" },
        ],
      }
    );
    return toPrompt(model_version);
  }

  /**
   * Same as mlflow.genai.load_prompt. Accepts "prompts:/name/3", "prompts:/name@alias" and
   * "prompts:/name@latest".
   */
  async loadPrompt(uri) {
    const match = uri.match(PROMPT_URI);
    if (!match) {
      throw new Error(`Not a prompt URI: ${uri}`);
    }
    const { name, version, alias } = match.groups;
    if (version) {
      const { model_version } = await this.call(
        "GET",
        "2.0/mlflow/model-versions/get",
        { name, version }
      );
      return toPrompt(model_version);
    }
    if (alias === "latest") {
      const { model_versions = [] } = await this.call(
        "GET",
        "2.0/mlflow/model-versions/search",
        {
          // Without the prompt tag in the filter, the server hides prompt versions from model search.
          filter: `name='${name}' AND tags.\`${IS_PROMPT_TAG}\` = 'true'`,
          max_results: 1000,
        }
      );
      if (model_versions.length === 0) {
        throw new Error(`Prompt ${name} has no versions`);
      }
      const latest = model_versions.reduce((a, b) =>
        Number(b.version) > Number(a.version) ? b : a
      );
      return toPrompt(latest);
    }
    const { model_version } = await this.call(
      "GET",
      "2.0/mlflow/registered-models/alias",
      { alias, name }
    );
    return toPrompt(model_version);
  }

  // ---------- Evaluation datasets ----------

  async findDataset(name, experimentId) {
    const { datasets = [] } = await this.call(
      "POST",
      "3.0/mlflow/datasets/search",
      {
        experiment_ids: [experimentId],
        filter_string: `name = '${name}'`,
      }
    );
    return datasets[0] ?? null;
  }

  async createDataset({ name, experimentId, tags = {} }) {
    const { dataset } = await this.call("POST", "3.0/mlflow/datasets/create", {
      experiment_ids: [experimentId],
      name,
      tags: JSON.stringify(tags),
    });
    return dataset;
  }

  /** Same as dataset.merge_records(): records are {inputs, expectations, tags}. */
  upsertRecords(datasetId, records) {
    return this.call("POST", `3.0/mlflow/datasets/${datasetId}/records`, {
      records: JSON.stringify(records),
    });
  }

  async getRecords(datasetId) {
    const records = [];
    let pageToken;
    do {
      const page = await this.call(
        "GET",
        `3.0/mlflow/datasets/${datasetId}/records`,
        {
          max_results: 1000,
          ...(pageToken ? { page_token: pageToken } : {}),
        }
      );
      records.push(...JSON.parse(page.records ?? "[]"));
      pageToken = page.next_page_token;
    } while (pageToken);
    return records;
  }

  // ---------- Runs ----------

  async createRun({ experimentId, runName, tags = {} }) {
    const { run } = await this.call("POST", "2.0/mlflow/runs/create", {
      experiment_id: experimentId,
      run_name: runName,
      start_time: Date.now(),
      tags: Object.entries(tags).map(([key, value]) => ({
        key,
        value: String(value),
      })),
    });
    return run.info.run_id;
  }

  logMetrics(runId, metrics, step = 0) {
    const timestamp = Date.now();
    return this.call("POST", "2.0/mlflow/runs/log-batch", {
      metrics: Object.entries(metrics).map(([key, value]) => ({
        key,
        step,
        timestamp,
        value,
      })),
      run_id: runId,
    });
  }

  logParams(runId, params) {
    return this.call("POST", "2.0/mlflow/runs/log-batch", {
      params: Object.entries(params).map(([key, value]) => ({
        key,
        value: String(value),
      })),
      run_id: runId,
    });
  }

  endRun(runId, status = "FINISHED") {
    return this.call("POST", "2.0/mlflow/runs/update", {
      end_time: Date.now(),
      run_id: runId,
      status,
    });
  }

  // ---------- Traces and assessments ----------

  /** Full trace (info + spans). Spans arrive in OTLP JSON form. */
  async getTrace(traceId) {
    const { trace } = await this.call("GET", "3.0/mlflow/traces/get", {
      trace_id: traceId,
    });
    return trace;
  }

  /**
   * Finds the trace the SDK exported for one agent run. The SDK traces every Prompt API call on
   * its own, so the run has no ID we chose: it is the trace whose request is the question, started
   * after `since` (a Date.now() taken just before the run). Judge and rewrite sessions also leave
   * traces, but their requests are other text. Waits for the batch exporter to deliver, calling
   * `flush` before each look: one flush right after the run was once not enough for a trace whose
   * root span had just ended, and the next flush delivered it.
   *
   * Span times come from performance.now(), not Date.now(), and the two drift apart (66 ms after
   * four minutes in Chrome Canary). So the window opens CLOCK_SLACK_MS early and the newest
   * match wins.
   */
  async findTrace({
    experimentId,
    question,
    since,
    flush,
    timeoutMs = 15_000,
  }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await flush?.();
      const { traces = [] } = await this.call(
        "POST",
        "3.0/mlflow/traces/search",
        {
          filter: `timestamp_ms >= ${since - CLOCK_SLACK_MS}`,
          locations: [
            {
              mlflow_experiment: { experiment_id: String(experimentId) },
              type: "MLFLOW_EXPERIMENT",
            },
          ],
          max_results: 100,
          order_by: ["timestamp_ms ASC"],
        }
      );
      const hit = traces.findLast((t) => t.request_preview === question);
      if (hit) {
        return this.getTrace(hit.trace_id);
      }
      if (Date.now() > deadline) {
        throw new Error(
          `No trace for "${question}" reached MLflow within ${timeoutMs / 1000}s. Check the experiment ID and the tracking URL.`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  /** Same as mlflow.set_trace_tag, for each entry. */
  async setTraceTags(traceId, tags) {
    for (const [key, value] of Object.entries(tags)) {
      await this.call("PATCH", `3.0/mlflow/traces/${traceId}/tags`, {
        key,
        value: String(value),
      });
    }
  }

  linkTracesToRun(runId, traceIds) {
    return this.call("POST", "2.0/mlflow/traces/link-to-run", {
      run_id: runId,
      trace_ids: traceIds,
    });
  }

  /** Shows the prompt version on the trace, and the trace on the prompt version page. */
  linkPromptToTrace(traceId, prompt) {
    return this.call("POST", "2.0/mlflow/traces/link-prompts", {
      prompt_versions: [{ name: prompt.name, version: String(prompt.version) }],
      trace_id: traceId,
    });
  }

  /** Same as mlflow.log_feedback. `source` is {source_type: CODE|LLM_JUDGE|HUMAN, source_id}. */
  logFeedback({ traceId, spanId, name, value, rationale, source, runId }) {
    return this.call("POST", `3.0/mlflow/traces/${traceId}/assessments`, {
      assessment: {
        assessment_name: name,
        feedback: { value },
        metadata: runId ? { [SOURCE_RUN_ID_KEY]: runId } : {},
        rationale,
        source,
        span_id: spanId,
        trace_id: traceId,
      },
    });
  }

  /** Same as mlflow.log_expectation: the ground truth shown next to the feedback in the UI. */
  logExpectation({ traceId, spanId, name, value, runId }) {
    return this.call("POST", `3.0/mlflow/traces/${traceId}/assessments`, {
      assessment: {
        assessment_name: name,
        expectation: { value },
        metadata: runId ? { [SOURCE_RUN_ID_KEY]: runId } : {},
        source: { source_id: "dataset", source_type: "HUMAN" },
        span_id: spanId,
        trace_id: traceId,
      },
    });
  }
}

function toPrompt(modelVersion) {
  const tags = Object.fromEntries(
    (modelVersion.tags ?? []).map((t) => [t.key, t.value])
  );
  const template = tags[PROMPT_TEXT_TAG];
  return {
    /** Same as PromptVersion.format(): fills {{ variable }} placeholders. */
    format(variables = {}) {
      return template.replace(TEMPLATE_VARIABLE, (whole, key) =>
        key in variables ? String(variables[key]) : whole
      );
    },
    name: modelVersion.name,
    template,
    uri: `prompts:/${modelVersion.name}/${modelVersion.version}`,
    version: Number(modelVersion.version),
  };
}

/** Span attributes from a trace fetched with getTrace(), as a plain object of parsed values. */
export function spanAttributes(span) {
  return Object.fromEntries(
    (span.attributes ?? []).map(({ key, value }) => [key, anyValue(value)])
  );
}

// Decodes an OTLP AnyValue. JSON objects come back from the server as kvlist/array values.
function anyValue(value) {
  if (!value) {
    return;
  }
  if ("kvlist_value" in value) {
    return Object.fromEntries(
      (value.kvlist_value.values ?? []).map((kv) => [
        kv.key,
        anyValue(kv.value),
      ])
    );
  }
  if ("array_value" in value) {
    return (value.array_value.values ?? []).map(anyValue);
  }
  if ("int_value" in value) {
    return Number(value.int_value);
  }
  return value.string_value ?? value.double_value ?? value.bool_value;
}
