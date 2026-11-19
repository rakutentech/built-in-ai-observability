# MLflow eval example: trace, evaluate and optimize an agent in the browser

A tiny customer-support agent that runs on Chrome's on-device model (Gemma 4 in Chrome Canary) through the [Prompt API](https://developer.chrome.com/docs/ai/prompt-api). You will trace it, measure how good it is, and let the model improve its own prompt, all with [MLflow](https://mlflow.org/) and plain browser JavaScript. No API key, no cloud model, no framework.

No background in evals or prompt management needed. The page walks through six numbered steps, and each step is one short file you can read top to bottom.

## The idea in one minute

You wrote an agent and its system prompt. Is it any good, and how do you make it better without guessing?

| Word | What it means here |
| --- | --- |
| **Prompt registry** | A versioned store for prompt text. Changing a prompt makes version 2, not an edit. The agent loads whichever version you ask for |
| **Trace** | A recording of one request: every model call and every tool call, with inputs, outputs and timings |
| **Dataset** | Example questions plus what a good answer looks like (the *expectations*) |
| **Scorer** | A check that grades one answer: a piece of code, or a second model call acting as a judge |
| **Evaluation** | Run the agent on every dataset question, grade each answer with the scorers, and average the grades. That average is your baseline |
| **Optimization** | Show a model the questions the agent failed and ask it to rewrite the prompt. Keep the rewrite if it scores higher |
| **Train / test split** | Optimize on the *train* questions, then check on *test* questions it never saw. A gain on both is real. A gain only on train is memorization |

## Run it

From the repository root:

```bash
pnpm install
pnpm build              # the workspace packages, then dist/sdk.js for this example
pnpm mlflow             # MLflow on http://localhost:5000 (any MLflow 3 server works)
pnpm dev:mlflow-eval    # http://localhost:8765
```

You need Chrome Canary with the Prompt API and its tool-use flag (`chrome://flags/#prompt-api-tool-use`). The page checks both. It shows a **Download the on-device model** button with a progress bar if the model isn't on the device yet. To see which model your Chrome uses, open `chrome://on-device-internals`.

Check the settings at the top of the page (MLflow URL, UI URL, experiment ID) and click **Save & reload** if you change them. They're kept in `localStorage`.

The page runs on one port and MLflow on another. That works because MLflow accepts cross-origin requests from `http://localhost:*` by default. For other origins, start MLflow with `--cors-allowed-origins`.

## Where to start reading

Open the files in this order. The numbered ones are the steps, and each has a button on the page.

| File | What it is |
| --- | --- |
| [`config.js`](./config.js) | Where MLflow is, which experiment, what things are called |
| [`tools.js`](./tools.js) | A fake order backend and three tools: `get_order_status`, `get_return_policy`, `start_return` |
| [`agent.js`](./agent.js) | The agent: loads its system prompt from the registry, runs the model with the tools |
| [`scorers.js`](./scorers.js) | Three scorers: one code check that reads the trace, two LLM judges |
| [`01-register-prompt.js`](./01-register-prompt.js) | Step 1 |
| [`02-run-agent.js`](./02-run-agent.js) | Step 2 |
| [`03-create-dataset.js`](./03-create-dataset.js) | Step 3 |
| [`04-evaluate.js`](./04-evaluate.js) | Step 4 |
| [`05-optimize.js`](./05-optimize.js) | Step 5 |
| [`06-compare.js`](./06-compare.js) | Step 6 |

The plumbing is in `lib/`. You don't need it to follow the steps:

| File | What it does | Python equivalent |
| --- | --- | --- |
| `lib/tracing.js` | Starts the SDK, which traces the Prompt API. Finds an agent run's trace afterwards | `mlflow.autolog()` |
| `lib/evaluate.js` | Runs the agent and scorers on each record and logs an evaluation run | `mlflow.genai.evaluate` |
| `lib/rewriter.js` | The model that rewrites the prompt | the optimizer's reflection model |
| `lib/dataset.js` | Reads the dataset back | `get_dataset` |
| `lib/mlflow-client.js` | `fetch()` calls to MLflow's REST API | `MlflowClient` |
| `lib/output.js`, `lib/page.js` | The log pane, the results table and the button wiring | |

And the build files: `index.html` (the page), `sdk-entry.js` and `tsdown.config.ts` (bundle the SDK into `dist/sdk.js`, the only build step), and `serve.js` (a static file server with no dependencies). The example's own files are served unchanged: edit one, reload the page.

## The steps

### 1. Register the baseline prompt (`01-register-prompt.js`)

Saves `"You are a customer support assistant for an online store."` as version 1 of the prompt `prompt-api-support-agent`. It is deliberately minimal, so there is something to improve.

**Look at:** MLflow → *Prompts* → `prompt-api-support-agent`.

**Why a registry?** `agent.js` loads its system prompt from it. That is what lets the optimizer in step 5 swap in a better prompt without touching the agent's code.

### 2. Run the agent (`02-run-agent.js`)

Asks one question with the latest prompt version. The agent can call the three tools: it asks the model, runs the tools the model requests, sends the results back, and repeats until the model answers.

The log shows the answer, a link to its trace, and the trace's spans as a tree:

```
invoke_agent                 one question, from start to finish
  generate_content           the model decides to call a tool
  execute_tool get_order_status
  generate_content           the model writes the answer
```

There is no tracing code in the agent. The SDK patches the Prompt API and exports each call to MLflow (see [Tracing](#tracing)).

**Look at:** MLflow → your experiment → *Traces*. Click the trace to see what the model was sent and what each tool returned. The baseline answers are probably long, in markdown, or ask the customer for things a tool could look up. That is what we will fix.

### 3. Create the dataset (`03-create-dataset.js`)

Creates a dataset of 10 questions. Each record has:

- `inputs`: the question
- `expectations`: the ground truth the scorers compare against. `expected_facts` is what the answer must say, and `expected_tools` is which tools the agent must call
- `tags.split`: `train` (7 rows, for the optimizer) or `test` (3 rows, held back)

**Look at:** MLflow → your experiment → *Datasets*.

### 4. Evaluate a prompt version (`04-evaluate.js`)

Runs the agent on every record of a split and grades each answer with three scorers:

- `uses_right_tools` (plain code): reads the tool spans from the trace. Passes if the expected tools were called, and `start_return` was *not* called unless the task needed it
- `correctness` (LLM judge): is every expected fact supported by the answer?
- `concise` (LLM judge): at most 3 sentences, no markdown?

Run it on version 1 and write down the averages. That is your baseline.

**Look at:** MLflow → *Evaluation runs*. Open the run, click a row, then the trace and the scorer's rationale. On the page, hover a score in the results table to read why.

### 5. Optimize the prompt (`05-optimize.js`)

A small version of what MLflow's optimizers (GEPA, MetaPrompt) do in Python:

1. Score the current prompt on the train split.
2. Show the model the questions it failed, with the scorers' reasons, and ask for a better prompt.
3. Score the new prompt. Keep it if it beats the best so far.
4. Repeat for the number of rounds you chose, then register the best prompt as a new version.

**Look at:** the log (each round's analysis and candidate), MLflow → *Prompts* → version 2, and the optimization run (a `candidate_score` metric per round).

### 6. Compare on the test split (`06-compare.js`)

Evaluates the old version and the newest one on the 3 test questions the optimizer never saw. In MLflow, select both runs under *Evaluation runs* and click *Compare*.

If the new version also wins here, the improvement is real. If only the train score rose, the optimizer memorized those 7 examples. With so little data that is a real risk, so add rows to `03-create-dataset.js` to try it.

## How it works

### Tracing

Nothing is traced by hand. `startTracing()` creates the SDK, which patches `LanguageModel` and exports every call over OTLP to `<MLflow URL>/v1/traces`, with the `x-mlflow-experiment-id` header. One agent question becomes one trace:

```
invoke_agent (AGENT)
├─ generate_content (LLM)
├─ execute_tool get_order_status (TOOL)
└─ generate_content (LLM)
```

Every Prompt API call leaves traces, not only the agent's: the judges, the rewriter, and each session's create, clone and destroy (`web_ai.create_session` and so on). An evaluation run therefore adds many traces to the experiment, mostly judge traffic. The agent's own traces carry `eval.*` tags, so you can filter on them.

Scores must be attached to a trace, and the SDK doesn't hand back the ID of the trace it sent. So after each agent run, `findTrace()` (`lib/tracing.js`) searches the experiment for the trace whose request is the question and that started after the run began, flushing the exporter and polling until it arrives. It then tags the trace (`eval.split` or `eval.candidate`, `eval.phase`, `prompt.uri`), links the prompt version, and logs the scores. This relies on agent runs being sequential, which they are, and on questions being distinct from judge prompts.

`uses_right_tools` reads `gen_ai.tool.name` from the `execute_tool` spans.

### Why a REST client?

MLflow's TypeScript package (`@mlflow/core`) covers tracing. It has no prompt registry, datasets, evaluation or optimization, and it targets Node. Those features exist only in Python. The Python functions are thin layers over REST endpoints, though, the same ones MLflow's UI calls, so `lib/mlflow-client.js` calls them directly:

| What | Endpoints |
| --- | --- |
| Prompts | `2.0/mlflow/registered-models/create`, `model-versions/create`, `model-versions/search`, `registered-models/alias`. A prompt is a registered model tagged `mlflow.prompt.is_prompt` |
| Datasets | `3.0/mlflow/datasets/create`, `datasets/search`, `datasets/{id}/records` |
| Runs | `2.0/mlflow/runs/create`, `runs/log-batch`, `runs/update` |
| Scores | `3.0/mlflow/traces/{trace_id}/assessments` |
| Links | `2.0/mlflow/traces/link-to-run`, `traces/link-prompts` |
| Finding and reading a trace | `3.0/mlflow/traces/search`, `3.0/mlflow/traces/get?trace_id=…`, `PATCH 3.0/mlflow/traces/{trace_id}/tags` |

### What evaluation writes

`lib/evaluate.js` writes the same records as `mlflow.genai.evaluate()`, so MLflow shows the result as one of its own evaluation runs:

- A run tagged `mlflow.runType=genai_evaluate`.
- For each record: the trace, the record's expectations, and one feedback per scorer. Every one carries the run ID in the `mlflow.assessment.sourceRunId` metadata.
- The traces linked to the run.
- `uses_right_tools/mean`, `correctness/mean` and `concise/mean` as run metrics.

The two judges use MLflow's own Correctness and Guidelines judge prompts, run on the on-device model. Each answers through a JSON `responseConstraint` (`{rationale, result: "yes" | "no"}`).

### Prompt API settings used

| Job | Session | `samplingMode` | Why |
| --- | --- | --- | --- |
| Agent | one base session per prompt (system prompt as `initialPrompts`, tools), `clone()`d per question | `most-predictable` | Runs should be comparable. Closest to temperature 0 |
| Judges | `create()` per verdict, `responseConstraint` for `{rationale, result}` | `most-predictable` | Verdicts should be repeatable. A fresh session means a judge never sees earlier rows |
| Prompt rewriter | `create()` per round, `responseConstraint` for `{analysis, prompt}` | `balanced` | Same failures in, same rewrite out: at `most-predictable` all ten rounds of one run were identical, and nothing could improve |

Measured in Chrome Canary:

- `clone()` carries the system prompt, the context, the tools and the sampling mode. The base session stays unchanged, and a clone answered a tool question with a tool call. It took about 1 ms where `create()` took about 400 ms.
- A clone replays its parent's sampling: four clones of a `balanced` session wrote the same rewrite four times, while three fresh `balanced` sessions wrote three different ones. Clone when you want repeatable runs, use `create()` when you want variety.
- Only clone from a session you never prompt. A clone starts with the parent's whole context, so a used parent makes every clone inherit its conversation.
- `availability()` gets the same options as `create()`, for all three configs (the page checks each), and `destroy()` is called on every session.

### Optimizer details

The rewriter keeps the prompts that failed to beat the best one (`<rejected>` in the meta-prompt) and is told not to repeat them. A rewrite identical to one already scored is skipped. It is also told to call a tool rather than ask the customer for something a tool can look up.

## What to expect

- **The baseline fails usefully.** It tends to ask the customer for details a tool could look up, guess return windows instead of calling `get_return_policy`, and answer in markdown.
- **Results are noisy.** With 7 training rows and a small model, scoring the same prompt twice can differ (a baseline scored 0.57 once and 0.52 another time). Optimization results vary: with 3 rounds the train score went from 0.52 to 0.62 while the test score stayed at 0.56, and with 4 rounds it went from 0.52 to 0.86 on train and from 0.56 to 0.89 on test. Rerun before trusting a gain. Step 6 exists to catch overfitting.
- **A small model is a lenient judge**, and here it grades its own answers. Hover a score to read the rationale. For numbers you can rely on, re-score the same traces with a stronger judge from Python: `mlflow.genai.evaluate(data=mlflow.search_traces(run_id=…), scorers=[…])`.

## Troubleshooting

- **Failed to fetch:** the MLflow URL is wrong, or the server is down.
- **No traces at all:** spans go to `<MLflow URL>/v1/traces` with the `x-mlflow-experiment-id` header. Check the experiment ID.
- **Many extra traces:** expected. The SDK traces every Prompt API call, including judges, the rewriter, and each session's create, clone and destroy. Filter on the `eval.*` tags, or open an evaluation run.
- **No trace for "…" reached MLflow:** the exporter didn't deliver in 15 s (or the experiment ID or URL is wrong). Keep the tab in the foreground: Chrome throttles timers in background tabs, which may delay the exporter.
- **Not a prompt URI or no versions:** run step 1 first.
- **`dist/sdk.js` 404:** run `pnpm build`.
- **The page says the model is unavailable or downloadable:** use the download button, or check `chrome://on-device-internals`.
