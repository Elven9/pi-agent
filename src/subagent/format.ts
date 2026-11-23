import { inputSummary, oneLine, scriptIntent } from "../tool-ref/format.ts";
import type { Scenario } from "../shared/scenarios/index.ts";
import { type ResultDetails, SEND_TO_LEADER, TOOL } from "./protocol.ts";
import { formatCost } from "./cost.ts";

/** Default and limits of the lookup tools (as tool-ref's). */
export const DEFAULT_MAX_CHARS = 4000;
export const MAX_IDS = 10;
export const GREP_PER_AGENT = 5;
export const GREP_TOTAL = 50;
export const GREP_LINE_CHARS = 200;
/** Progress lines kept per live child (memory only). */
export const PROGRESS_KEEP = 20;
/** Widget rows before `+k more`. */
export const WIDGET_ROWS = 5;
const LINE_CHARS = 160;

/** `45s`, `2m14s`, `1h02m`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Status shown for a result: `killed by user`, `aborted (reload)`, else the status. */
export function statusLabel(d: ResultDetails): string {
  const { status, reason } = d.envelope.body;
  if (status === "killed" && reason) return `killed by ${reason}`;
  if (status === "aborted" && reason && reason !== "leader_exit") return `aborted (${reason})`;
  return status;
}

export const isAbnormal = (d: ResultDetails): boolean => !["ok", "error"].includes(d.envelope.body.status);

/** Label of a subagent without a scenario (pi's own prompt and tools). */
export const GENERAL = "general";

/** The scenario's name, or GENERAL for a subagent without one. */
export const scenarioLabel = (scenario: string | undefined): string => scenario ?? GENERAL;

/** ` · $0.06` when the result records its cost, else empty. */
export const costPart = (d: Pick<ResultDetails, "costUsd">): string => (d.costUsd !== undefined ? ` · ${formatCost(d.costUsd)}` : "");

/** `a3 · review · ok · 2m14s · $0.06` */
export function resultHeader(d: ResultDetails): string {
  return `${d.resultId} · ${scenarioLabel(d.scenario)} · ${statusLabel(d)} · ${formatDuration(d.endedAt - d.startedAt)}${costPart(d)}`;
}

/**
 * The text the leader's model sees for a result: header and summary; for a task that did not
 * finish by itself also the task, so the model can decide on a restart.
 */
export function resultContent(d: ResultDetails): string {
  const body = d.envelope.body;
  const lines = [`[subagent ${d.resultId}] ${scenarioLabel(d.scenario)} · ${statusLabel(d)} · ${formatDuration(d.endedAt - d.startedAt)}${costPart(d)}${provenance(d)}`, body.summary];
  if (body.detail !== undefined) lines.push(`(structured detail: ${TOOL.get} ${d.resultId})`);
  if (isAbnormal(d)) {
    lines.push("", `Task (${scenarioLabel(d.scenario)}${d.project ? `, project ${d.project}` : ""}):`, d.task, "", `Restart it with ${TOOL.restart} if it is still needed.`);
  }
  return lines.join("\n");
}

/** ` · restart of a2 · started by user`: where a subagent came from, when it is not a plain model spawn. */
export function provenance(d: Pick<ResultDetails, "restartOf" | "startedBy">): string {
  return (d.restartOf ? ` · restart of ${d.restartOf}` : "") + (d.startedBy === "user" ? " · started by user" : "");
}

/**
 * The in-context notice for a subagent the user started (the model saw no tool call for it), so a
 * later result, or the agent in subagent_get, is not a surprise.
 */
export function userStartContent(start: { id: string; scenario?: string; task: string; restartOf?: string }): string {
  return [
    `[subagent ${start.id}] started by user${start.restartOf ? `: restart of ${start.restartOf}` : ""} (${scenarioLabel(start.scenario)})`,
    `Task: ${start.task}`,
    "Its result arrives later as a message like the subagents you start.",
  ].join("\n");
}

/** The prompt a child gets: the task, then how to report back. */
export function taskPrompt(agent: string, task: string, scenario: Scenario | undefined): string {
  const lines = [
    `Task from your leader (you are subagent ${agent}${scenario ? `, scenario ${scenario.name}` : ""}):`,
    "",
    task,
    "",
    `When you are done, call the ${SEND_TO_LEADER} tool exactly once:`,
    '- status: "ok" when the task is done, "error" when you could not do it',
    "- summary: the outcome in a few sentences; it is what the leader reads first",
  ];
  if (scenario) {
    lines.push(
      `- detail: optional structured result; when given it must match this JSON Schema (${scenario.detailKind}):`,
      "",
      "```json",
      JSON.stringify(scenario.detailSchema, null, 2),
      "```",
    );
  } else {
    lines.push("- detail: optional structured result (an object)");
  }
  lines.push("", "You cannot ask the leader questions: decide yourself and state your assumptions in the summary.");
  return lines.join("\n");
}

/** One progress line for a child's tool call: a codemode script's `// intent:`, else `<tool> <input>`. */
export function progressLine(toolName: string, args: unknown): string {
  const input = args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;
  if (toolName === "codemode" && typeof input?.code === "string") {
    const intent = scriptIntent(input.code);
    if (intent) return oneLine(intent, LINE_CHARS);
  }
  return oneLine(`${toolName} ${inputSummary({ toolName, input })}`, LINE_CHARS);
}

/**
 * Page text with its section headings (`task:`, `summary:`, …): `headings` are line indices, so
 * the /agent panel can style them without guessing from the text (a task may contain `summary:`).
 */
export interface SectionedText {
  lines: string[];
  headings: number[];
}

/** Appends `heading` (recorded as a heading) and its body lines, after a blank line unless first. */
function addSection(t: SectionedText, heading: string, body: readonly string[]): void {
  if (t.lines.length) t.lines.push("");
  t.headings.push(t.lines.length);
  t.lines.push(heading, ...body);
}

/** `model anthropic/x`, `thinking high`: what a child ran on, when recorded. */
export function modelParts(d: { model?: string; thinking?: string }): string[] {
  return [...(d.model ? [`model ${d.model}`] : []), ...(d.thinking ? [`thinking ${d.thinking}`] : [])];
}

/** The full text of a result (lookup tools). */
export function resultLines(d: ResultDetails): string[] {
  return resultPage(d).lines;
}

/** The full text of a result with its headings (the /agent panel); same lines as resultLines. */
export function resultPage(d: ResultDetails): SectionedText {
  const body = d.envelope.body;
  const meta = [
    `started ${new Date(d.startedAt).toISOString()}`,
    `ended ${new Date(d.endedAt).toISOString()}`,
    ...(d.restartOf ? [`restart of ${d.restartOf}`] : []),
    ...(d.startedBy === "user" ? ["started by user"] : []),
    ...(d.project ? [`project ${d.project}`] : []),
    ...modelParts(d),
    ...(d.costUsd !== undefined ? [`cost ${formatCost(d.costUsd)}`] : []),
  ].join(" · ");
  const t: SectionedText = { lines: [meta], headings: [] };
  addSection(t, "task:", d.task.split("\n"));
  addSection(t, "summary:", body.summary.split("\n"));
  if (body.detail !== undefined) {
    addSection(t, `detail${body.detailKind ? ` (${body.detailKind})` : ""}:`, JSON.stringify(body.detail, null, 2).split("\n"));
  }
  return t;
}

/** The /agent page of a recorded task without a result. */
export function noResultPage(task: string): SectionedText {
  const t: SectionedText = { lines: ["no result recorded"], headings: [] };
  addSection(t, "task:", task.split("\n"));
  return t;
}

/** A child that is still running, as the lookup tools and the panel show it. */
export interface LiveView {
  id: string;
  /** The scenario's name, or GENERAL. */
  scenario: string;
  state: string;
  task: string;
  startedAt: number;
  line: string;
  progress: readonly string[];
  restartOf?: string;
  model?: string;
  thinking?: string;
}

export function liveHeader(c: LiveView, now: number): string {
  return `${c.id} · ${c.scenario} · ${c.state} · running ${formatDuration(now - c.startedAt)}`;
}

/** Widget rows, one per live child, capped at WIDGET_ROWS with a `+k more` row. */
export function widgetLines(children: readonly LiveView[], now: number): string[] {
  if (children.length === 0) return [];
  const width = Math.max(...children.map((c) => c.scenario.length));
  const rows = children.map((c) => {
    const mark = c.state === "busy" ? "●" : "◌";
    return `${mark} ${c.id} ${c.scenario.padEnd(width)}  ${c.state.padEnd(8)} ${formatDuration(now - c.startedAt).padStart(6)}  ${c.line}`;
  });
  if (rows.length <= WIDGET_ROWS) return rows;
  return [...rows.slice(0, WIDGET_ROWS - 1), `+${rows.length - WIDGET_ROWS + 1} more (/agent)`];
}

/** Footer status (right end of the cwd line): `🤖 2 busy · 1 starting`. */
export function statusText(children: readonly LiveView[]): string | undefined {
  if (children.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const c of children) {
    const word = c.state === "spawning" ? "starting" : c.state;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return `🤖 ${[...counts].map(([w, n]) => `${n} ${w}`).join(" · ")}`;
}

/** The `/agent` panel page of a live child. */
export function livePage(c: LiveView, now: number): SectionedText {
  const meta = [...(c.restartOf ? [`restart of ${c.restartOf}`] : []), ...modelParts(c)].join(" · ");
  const t: SectionedText = { lines: [liveHeader(c, now), ...(meta ? [meta] : [])], headings: [] };
  addSection(t, "task:", c.task.split("\n"));
  addSection(t, "progress:", c.progress.length === 0 ? [`  ${c.line}`] : c.progress.map((p) => `  ${p}`));
  t.lines.push("", "x: kill");
  return t;
}

export interface GetOptions {
  lines?: [number, number];
  maxChars?: number;
}

/** Numbered lines `[from, to]` (1-based, inclusive; negative counts from the end). */
function selectLines(all: readonly string[], range: [number, number] | undefined): { from: number; to: number; lines: string[] } {
  const n = all.length;
  if (!range) return { from: 1, to: n, lines: [...all] };
  const at = (v: number) => (v < 0 ? n + v + 1 : v);
  const from = Math.max(1, Math.min(n, at(range[0])));
  const to = Math.max(from, Math.min(n, at(range[1])));
  return { from, to, lines: all.slice(from - 1, to) };
}

/** `subagent_get` text for one finished result. */
export function formatGet(d: ResultDetails, opts: GetOptions = {}): string {
  const all = resultLines(d);
  const { from, to, lines } = selectLines(all, opts.lines);
  const width = String(to).length;
  let text = lines.map((l, i) => `${String(from + i).padStart(width)}  ${l}`).join("\n");
  const max = opts.maxChars ?? DEFAULT_MAX_CHARS;
  let note = "";
  if (text.length > max) {
    text = text.slice(0, max);
    note = `\n… cut at ${max} chars; use lines or maxChars to see more`;
  }
  const range = from === 1 && to === all.length ? `${all.length} lines` : `lines ${from}-${to} of ${all.length}`;
  return `──── ${resultHeader(d)} (${range}) ────\n${text}${note}`;
}

/** Case-insensitive unless the pattern has an uppercase letter (as tool_ref_grep). */
export function compilePattern(pattern: string): RegExp {
  return new RegExp(pattern, /[A-Z]/.test(pattern) ? "" : "i");
}

export interface GrepHit {
  resultId: string;
  header: string;
  matches: Array<{ line: number; text: string }>;
}

/** Matches of `re` in each result's text, newest first, with `context` lines around each match. */
export function grepResults(results: readonly ResultDetails[], re: RegExp, context = 0): { hits: GrepHit[]; omitted: number } {
  const hits: GrepHit[] = [];
  let total = 0;
  let omitted = 0;
  for (const d of [...results].reverse()) {
    const lines = resultLines(d);
    const matched = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
    if (matched.length === 0) continue;
    const keep = new Set<number>();
    let shown = 0;
    for (const i of matched) {
      if (shown >= GREP_PER_AGENT || total >= GREP_TOTAL) {
        omitted++;
        continue;
      }
      shown++;
      total++;
      for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j);
    }
    if (keep.size === 0) continue;
    hits.push({
      resultId: d.resultId,
      header: resultHeader(d),
      matches: [...keep].sort((a, b) => a - b).map((i) => ({ line: i + 1, text: oneLine(lines[i]!, GREP_LINE_CHARS) })),
    });
  }
  return { hits, omitted };
}

export function formatGrep(r: { hits: GrepHit[]; omitted: number }): string {
  if (r.hits.length === 0) return "No matches.";
  const out = r.hits.flatMap((h) => [h.header, ...h.matches.map((m) => `  ${m.line}: ${m.text}`)]);
  if (r.omitted) out.push(`(${r.omitted} more matches left out; narrow the pattern or pass ids)`);
  return out.join("\n");
}
