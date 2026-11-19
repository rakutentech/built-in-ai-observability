// What the steps "print": a log pane at the bottom of the page and a results table.

const $ = (selector) => document.querySelector(selector);

/** Adds a line to the log pane, optionally ending with a link. */
export function log(text, link) {
  const line = document.createElement("div");
  line.textContent = text;
  if (link) {
    const a = Object.assign(document.createElement("a"), {
      href: link.href,
      target: "_blank",
      textContent: ` ${link.label}`,
    });
    line.append(a);
  }
  $("#log").append(line);
  $("#log").scrollTop = $("#log").scrollHeight;
}

const escapeHtml = (text) =>
  String(text ?? "").replace(
    /[&<>"]/gu,
    (c) => ({ '"': "&quot;", "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]
  );

const isPass = (value) => value === true || value === "yes";

/** One row per question, one column per scorer. Hover a score to read the judge's rationale. */
export function showResults(rows, scorers) {
  const cell = (feedback) =>
    feedback
      ? `<td class="${isPass(feedback.value) ? "ok" : "bad"}" title="${escapeHtml(feedback.rationale)}">${feedback.value}</td>`
      : "<td>–</td>";
  const header = scorers.map((s) => `<th>${s.name}</th>`).join("");
  const body = rows
    .map(
      (row) =>
        `<tr><td>${escapeHtml(row.inputs.question)}</td><td>${escapeHtml(row.output?.answer ?? row.error)}</td>${scorers.map((s) => cell(row.scores[s.name])).join("")}</tr>`
    )
    .join("");
  $("#results").innerHTML =
    `<table><tr><th>question</th><th>answer</th>${header}</tr>${body}</table>` +
    '<div class="muted">Hover a score for the rationale.</div>';
}
