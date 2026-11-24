import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { footerSessionStart, setFooterPart } from "../shared/footer.ts";
import { newSessionId, parentLinkEnv } from "../shared/parent-link.ts";
import { getScenario, scenarioNames, type Scenario } from "../shared/scenarios/index.ts";
import { registerChild } from "./child.ts";
import {
  compilePattern,
  DEFAULT_MAX_CHARS,
  formatGet,
  formatGrep,
  grepResults,
  liveHeader,
  livePage,
  noResultPage,
  MAX_IDS,
  resultContent,
  resultHeader,
  resultPage,
  scenarioLabel,
  statusLabel,
  statusText,
  taskPrompt,
  userStartContent,
  widgetLines,
} from "./format.ts";
import { SubagentManager } from "./manager.ts";
import {
  agentId,
  ENTRY,
  messageId,
  parseAgentId,
  type ResultDetails,
  type StartRecord,
  type StartedBy,
  SUBAGENT_COMMAND_ENV,
  SUBAGENT_ENV,
  THINKING_LEVELS,
  type ThinkingLevel,
  TOOL,
  UI_KEY,
} from "./protocol.ts";
import { type EntryLike, enteredWorktree, indexBranch, maxAgentId, pendingResults, type SubagentIndex } from "./records.ts";
import { resultRenderer, userStartRenderer } from "./render.ts";
import { type ChildHandle, RpcChild } from "./rpc.ts";
import { type AgentPage, AgentViewer, VIEWER_OVERLAY } from "./viewer.ts";

/**
 * Subagent extension (docs/subagent-design.md). A leader session spawns one-shot task children,
 * each `pi --mode rpc [--scenario <name>]` in its own process (without one: a general pi agent); a child reports once with
 * `send_to_leader`, and the result becomes a `subagent-result` custom message in the leader's
 * context. In a child (PI_AGENT_SUBAGENT=1) only `send_to_leader` is registered, so children
 * cannot spawn.
 *
 * Leader: tools `subagent_spawn`, `subagent_kill`, `subagent_restart`, `subagent_get`,
 * `subagent_grep`; command `/agent`; a progress widget and footer status (display only);
 * a renderer for result rows. Session end stops every child (SIGTERM, SIGKILL after the grace
 * period) and records what is missing as `subagent-end` entries; every session start turns
 * those, and tasks with no record at all (crash), into result messages.
 */

export interface SubagentOptions {
  /** Child side; default: PI_AGENT_SUBAGENT=1 in the environment. */
  child?: boolean;
  /** Child side: environment with the parent link (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** Starts a child process (tests inject fakes). */
  startChild?: (start: StartRecord, ctx: ExtensionContext) => ChildHandle;
  /** SIGTERM → SIGKILL grace period (default 2 s). */
  graceMs?: number;
  now?: () => number;
}

const GRACE_MS = 2000;

export default function subagent(pi: ExtensionAPI, options: SubagentOptions = {}): void {
  if (options.child ?? process.env[SUBAGENT_ENV] === "1") {
    registerChild(pi, options.env);
    return;
  }
  registerLeader(pi, options);
}

/** The command that starts a pi child: SUBAGENT_COMMAND_ENV, else this process's own pi. */
export function childCommand(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): string[] {
  const override = env[SUBAGENT_COMMAND_ENV];
  if (override) {
    const parsed = JSON.parse(override) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((p) => typeof p === "string")) return parsed;
    throw new Error(`${SUBAGENT_COMMAND_ENV} must be a JSON array of strings`);
  }
  return argv[1] ? [process.execPath, argv[1]] : ["pi"];
}

/**
 * CLI arguments of a child: RPC mode, the scenario, project, its model and thinking level
 * (recorded, else the leader's current ones), its session folder and ID.
 */
export function childArgs(
  start: StartRecord,
  leader: { model?: { provider: string; id: string }; thinking?: ThinkingLevel },
  leaderSessionFile: string | undefined,
): string[] {
  // A scenario sets its own tools; a general child gets pi's defaults plus codemode (children are codemode-only, see registerChild).
  const args = ["--mode", "rpc", ...(start.scenario !== undefined ? ["--scenario", start.scenario] : ["--tools", "+codemode"]), "--name", `subagent ${agentId(start.id)} (${scenarioLabel(start.scenario)})`];
  if (start.project) args.push("--project", start.project);
  const model = start.model ?? (leader.model && modelName(leader.model));
  if (model) args.push("--model", model);
  const thinking = start.thinking ?? leader.thinking;
  if (thinking) args.push("--thinking", thinking);
  // Child sessions next to the leader's, in their own folder (kept out of the leader's /resume list).
  if (leaderSessionFile) {
    args.push("--session-dir", join(dirname(leaderSessionFile), "subagents"));
    // Chosen by the leader and recorded at spawn, so the link does not depend on the child reporting.
    if (start.childSessionId) args.push("--session-id", start.childSessionId);
  } else args.push("--no-session");
  return args;
}

const modelName = (m: { provider: string; id: string }): string => `${m.provider}/${m.id}`;

/** Most models listed in an unknown-model error. */
const MODELS_LISTED = 40;

/**
 * Checks a spawn's `model`: an exact `provider/id` of a model with credentials (`available`).
 * Throws with the available models listed.
 */
export function checkModel(name: string, available: readonly { provider: string; id: string }[]): string {
  const names = [...new Set(available.map(modelName))];
  if (names.includes(name)) return name;
  const listed = names.slice(0, MODELS_LISTED).join(", ") + (names.length > MODELS_LISTED ? `, … (${names.length - MODELS_LISTED} more)` : "");
  throw new Error(`Unknown or unavailable model "${name}": give an exact provider/id of a model with credentials. Available: ${listed || "none"}`);
}

function defaultStartChild(start: StartRecord, ctx: ExtensionContext): ChildHandle {
  const [command, ...prefix] = childCommand();
  const args = [...prefix, ...childArgs(start, { model: ctx.model, thinking: ctx.thinkingLevel }, ctx.sessionManager.getSessionFile())];
  // In the leader's entered worktree, if any (the worktree extension keeps ctx.cwd unchanged).
  const cwd = enteredWorktree(ctx.sessionManager.getBranch() as unknown as EntryLike[]) ?? ctx.cwd;
  // The child records the leader's session as its parent (child.ts); only when both have sessions.
  const link = start.childSessionId !== undefined && { ...parentLinkEnv({ sessionId: leaderSessionId(ctx), agentId: agentId(start.id) }) };
  return new RpcChild(command!, args, { cwd, env: { ...process.env, [SUBAGENT_ENV]: "1", ...link } });
}

/** The leader's session ID: its header's, as session-upload uses. */
function leaderSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getHeader()?.id ?? ctx.sessionManager.getSessionId();
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

function scenarioOf(name: string | undefined): Scenario | undefined {
  if (name === undefined) return undefined;
  try {
    return getScenario(name);
  } catch {
    return undefined;
  }
}

const ID = Type.String({ description: "Agent ID, e.g. a3" });

function registerLeader(pi: ExtensionAPI, options: SubagentOptions): void {
  const now = options.now ?? (() => Date.now());
  const startChild = options.startChild ?? defaultStartChild;

  /** Latest context: session_start's, or the tool/command call that spawns. */
  let ctx: ExtensionContext | undefined;
  let nextId = 1;
  /** The session is ending: results go to `subagent-end` entries, not messages. */
  let closing = false;
  /** Results waiting for the leader to be idle. `wake`: start a turn for them. */
  const inbox: Array<{ result: ResultDetails; wake: boolean }> = [];
  let ticker: ReturnType<typeof setInterval> | undefined;

  const message = (r: ResultDetails) => ({ customType: ENTRY.result, content: resultContent(r), display: true, details: r });

  /** Delivers waiting results when the leader is idle: one message each, the last one starts a turn. */
  const flush = () => {
    if (closing || !ctx || inbox.length === 0) return;
    let idle: boolean;
    try {
      idle = ctx.isIdle();
    } catch {
      return;
    }
    if (!idle) return;
    const items = inbox.splice(0);
    const wake = items.some((i) => i.wake);
    items.forEach((item, i) => pi.sendMessage(message(item.result), i === items.length - 1 && wake ? { triggerTurn: true } : undefined));
  };

  /** The count at the right end of the footer's cwd line (TUI), else a status. */
  const setStatus = (c: ExtensionContext, text: string | undefined) => {
    if (c.mode === "tui") setFooterPart(pi, c, UI_KEY, "right", text);
    else c.ui.setStatus(UI_KEY, text);
  };

  const updateUI = () => {
    if (closing || !ctx?.hasUI) return;
    const views = manager.views();
    try {
      // Grey like the footer.
      const dim = (l: string) => ctx!.ui.theme.fg("dim", l);
      ctx.ui.setWidget(UI_KEY, views.length ? widgetLines(views, now()).map(dim) : undefined);
      setStatus(ctx, statusText(views));
    } catch {
      return;
    }
    if (views.length && !ticker) {
      ticker = setInterval(updateUI, 1000);
      ticker.unref?.();
    } else if (!views.length && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  const manager = new SubagentManager({
    startChild: (start) => startChild(start, ctx!),
    prompt: (start) => taskPrompt(agentId(start.id), start.task, scenarioOf(start.scenario)),
    onResult: (result) => {
      // A kill is already known to whoever did it: recorded without starting a turn.
      inbox.push({ result, wake: result.envelope.body.status !== "killed" });
      flush();
    },
    onChange: () => updateUI(),
    now,
    graceMs: options.graceMs ?? GRACE_MS,
  });

  const index = (c: ExtensionContext): SubagentIndex => indexBranch(c.sessionManager.getBranch() as unknown as EntryLike[]);

  /** Records and starts a child. */
  const spawn = (
    c: ExtensionContext,
    spec: { scenario?: string; task: string; project?: string; model?: string; thinking?: ThinkingLevel; restartOf?: number },
    startedBy: StartedBy,
  ): number => {
    ctx = c;
    const id = nextId++;
    // The leader's unless chosen; recorded so a restart runs the same even after the leader switched.
    const model = spec.model ?? (c.model ? modelName(c.model) : undefined);
    const thinking = spec.thinking ?? c.thinkingLevel;
    const start: StartRecord = {
      id,
      ...(spec.scenario !== undefined && { scenario: spec.scenario }),
      kind: "task",
      task: spec.task,
      ...(spec.project && { project: spec.project }),
      ...(model && { model }),
      ...(thinking && { thinking }),
      startedAt: now(),
      ...(spec.restartOf !== undefined && { restartOf: spec.restartOf }),
      ...(startedBy === "user" && { startedBy }),
      taskMessageId: messageId(now()),
      // The child's session ID, when it gets a session file (the leader has one).
      ...(c.sessionManager.getSessionFile() && { childSessionId: newSessionId(now()) }),
    };
    pi.appendEntry(ENTRY.start, start);
    // The model sees its own spawns as tool calls; a user's start needs a notice in context. No
    // turn: stored now when idle, appended after the current turn when busy.
    if (startedBy === "user") {
      const content = userStartContent({
        id: agentId(id),
        ...(start.scenario !== undefined && { scenario: start.scenario }),
        task: start.task,
        ...(start.restartOf !== undefined && { restartOf: agentId(start.restartOf) }),
      });
      pi.sendMessage({ customType: ENTRY.userStart, content, display: true, details: { agentId: agentId(id), start } });
    }
    manager.spawn(start);
    return id;
  };

  const restart = (c: ExtensionContext, id: number, by: StartedBy): string => {
    if (manager.has(id)) throw new Error(`${agentId(id)} is still running; kill it first`);
    const recorded = index(c).get(id);
    if (!recorded) throw new Error(`${agentId(id)}: no such subagent on this branch`);
    const s = recorded.start;
    const next = spawn(
      c,
      {
        ...(s.scenario !== undefined && { scenario: s.scenario }),
        task: s.task,
        ...(s.project && { project: s.project }),
        ...(s.model && { model: s.model }),
        ...(s.thinking && { thinking: s.thinking }),
        restartOf: id,
      },
      by,
    );
    return `Restarted ${agentId(id)} as ${agentId(next)} (${scenarioLabel(s.scenario)}).`;
  };

  const kill = async (id: number, by: "user" | "leader", c: ExtensionContext): Promise<string> => {
    if (!manager.has(id)) {
      const r = index(c).get(id);
      if (r?.result) return `${agentId(id)} already finished (${statusLabel(r.result)}).`;
      throw new Error(`${agentId(id)} is not running`);
    }
    const result = await manager.kill(id, by);
    return result ? `${agentId(id)}: ${statusLabel(result)}.` : `${agentId(id)} stopped.`;
  };

  pi.on("session_start", (_event, c) => {
    ctx = c;
    closing = false;
    footerSessionStart(pi, c);
    nextId = maxAgentId(c.sessionManager.getEntries() as unknown as EntryLike[]) + 1;
    // Results recorded at the last session end, and tasks the leader left without any record
    // (crash, SIGKILL): written now as messages, without starting a turn.
    const pending = pendingResults(index(c), now(), manager.ids());
    for (const r of pending) pi.sendMessage(message(r));
    if (pending.length && c.hasUI) {
      c.ui.notify(`Subagent results from the last session end: ${pending.map((r) => `${r.agentId} ${statusLabel(r)}`).join(", ")}`, "info");
    }
    updateUI();
  });

  pi.on("session_before_switch", async (event, c) => {
    if (manager.size === 0 || !c.hasUI) return;
    const ids = manager.views().map((v) => v.id).join(", ");
    const action = event.reason === "new" ? "start a new session" : "switch sessions";
    const ok = await c.ui.confirm("Subagents running", `${manager.size} subagent(s) running (${ids}). Kill them and ${action}?`);
    if (!ok) return { cancel: true };
  });

  pi.on("session_shutdown", async (event) => {
    closing = true;
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    const reason = event.reason === "quit" ? "leader_exit" : event.reason;
    const ended = await manager.shutdown(reason);
    // appendEntry is written even while the leader streams (a sendMessage would be lost); the
    // next session start turns these into result messages.
    for (const { result } of inbox.splice(0)) pi.appendEntry(ENTRY.end, { result });
    for (const result of ended) pi.appendEntry(ENTRY.end, { result });
    try {
      ctx?.ui.setWidget(UI_KEY, undefined);
      if (ctx) setStatus(ctx, undefined);
    } catch {
      // UI already gone.
    }
  });

  pi.on("agent_settled", () => flush());

  pi.registerMessageRenderer(ENTRY.userStart, userStartRenderer);

  // A click on a result row (fullscreen mode) opens its panel, like `/agent aN`.
  pi.registerMessageRenderer(
    ENTRY.result,
    resultRenderer((resultId) => {
      const n = parseAgentId(resultId);
      if (n === undefined || !ctx || ctx.mode !== "tui") return;
      void openPanel(ctx, [n], `/agent ${resultId}`, 0);
    }),
  );

  // ── tools ──

  const names = scenarioNames();
  pi.registerTool({
    name: TOOL.spawn,
    label: "Subagent: spawn",
    description:
      "Start a subagent: a separate pi agent that runs one task in the background, with a scenario's prompt and tools, " +
      "or without a scenario as a general pi agent (pi's own prompt, tools and docs). " +
      "Returns its ID (a3) at once; its result arrives later as a `[subagent a3]` message that starts a new turn. " +
      `Scenarios: ${names.join(", ")}. ` +
      "Runs on your model and thinking level unless `model` (exact provider/id) or `thinking` is given.",
    promptGuidelines: [
      `Use \`${TOOL.spawn}\` to delegate self-contained tasks that can run in parallel with your own work. Give the task everything it needs: the subagent cannot ask you questions.`,
      `Subagent results arrive by themselves as \`[subagent aN]\` messages; do not poll or wait for them. Look results up again with \`${TOOL.get}\` / \`${TOOL.grep}\`.`,
    ],
    parameters: Type.Object({
      scenario: Type.Optional(
        Type.Unsafe<string>({ type: "string", enum: names, description: "Scenario the subagent runs; leave out for a general pi agent" }),
      ),
      task: Type.String({ description: "The complete task: goal, context, constraints, what to report" }),
      project: Type.Optional(Type.String({ description: "Project folder (--project) for the subagent" })),
      model: Type.Optional(
        Type.String({ description: "Exact provider/id of the model to run on, e.g. anthropic/claude-sonnet-4-5; default: your own model" }),
      ),
      thinking: Type.Optional(
        Type.Unsafe<ThinkingLevel>({
          type: "string",
          enum: [...THINKING_LEVELS],
          description: "Thinking level (default: your own); clamped to what the model supports",
        }),
      ),
    }),
    async execute(
      _id,
      params: { scenario?: string; task: string; project?: string; model?: string; thinking?: ThinkingLevel },
      _signal,
      _update,
      c,
    ) {
      if (params.scenario !== undefined && !names.includes(params.scenario)) throw new Error(`Unknown scenario "${params.scenario}". Scenarios: ${names.join(", ")}`);
      if (params.thinking !== undefined && !THINKING_LEVELS.includes(params.thinking)) {
        throw new Error(`Unknown thinking level "${params.thinking}". Levels: ${THINKING_LEVELS.join(", ")}`);
      }
      // Models with credentials, and the leader's own (it runs, also when not listed there).
      if (params.model !== undefined) checkModel(params.model, [...(c.model ? [c.model] : []), ...c.modelRegistry.getAvailable()]);
      const id = spawn(c, params, "model");
      return text(
        `Started subagent ${agentId(id)} (${scenarioLabel(params.scenario)}${params.model ? `, ${params.model}` : ""}${params.thinking ? `, thinking ${params.thinking}` : ""}). Its result arrives later as a [subagent ${agentId(id)}] message and starts a new turn; ` +
          "do not wait or poll: continue with other work or end your turn.",
      );
    },
  } as ToolDefinition<TSchema>);

  pi.registerTool({
    name: TOOL.kill,
    label: "Subagent: kill",
    description: "Kill a running subagent. It ends with a `killed` result.",
    parameters: Type.Object({ id: ID }),
    async execute(_id, params: { id: string }, _signal, _update, c) {
      const n = parseAgentId(params.id);
      if (n === undefined) throw new Error(`Not an agent ID: ${params.id}`);
      return text(await kill(n, "leader", c));
    },
  } as ToolDefinition<TSchema>);

  pi.registerTool({
    name: TOOL.restart,
    label: "Subagent: restart",
    description: "Start a finished subagent's task again in a fresh subagent (same scenario, task and project; new ID).",
    parameters: Type.Object({ id: ID }),
    async execute(_id, params: { id: string }, _signal, _update, c) {
      const n = parseAgentId(params.id);
      if (n === undefined) throw new Error(`Not an agent ID: ${params.id}`);
      return text(restart(c, n, "model"));
    },
  } as ToolDefinition<TSchema>);

  pi.registerTool({
    name: TOOL.get,
    label: "Subagent: get",
    description:
      "Show subagent results by ID: task, summary and structured detail, with numbered lines. A running subagent shows its state. " +
      "Use `lines` for a range and `maxChars` to see more.",
    parameters: Type.Object({
      ids: Type.Array(ID, { minItems: 1, maxItems: MAX_IDS, description: `Agent IDs (at most ${MAX_IDS})` }),
      lines: Type.Optional(
        Type.Array(Type.Integer(), { minItems: 2, maxItems: 2, description: "Line range, 1-based and inclusive; negative counts from the end" }),
      ),
      maxChars: Type.Optional(Type.Integer({ minimum: 100, description: `Characters per result (default ${DEFAULT_MAX_CHARS})` })),
    }),
    annotations: { readOnlyHint: true },
    async execute(_id, params: { ids: string[]; lines?: [number, number]; maxChars?: number }, _signal, _update, c) {
      const idx = index(c);
      const out = params.ids.map((raw) => {
        const n = parseAgentId(raw);
        if (n === undefined) return `${raw}: not an agent ID`;
        const live = manager.view(n);
        if (live) return `${liveHeader(live, now())} (no result yet)`;
        const r = idx.get(n);
        if (!r) return `${agentId(n)}: no such subagent on this branch`;
        const result = r.result ?? r.end;
        if (!result) return `${agentId(n)} (${r.start.scenario}): no result recorded`;
        return formatGet(result, params);
      });
      return text(out.join("\n\n"));
    },
  } as ToolDefinition<TSchema>);

  pi.registerTool({
    name: TOOL.grep,
    label: "Subagent: grep",
    description:
      "Find subagent results by regex over their task, summary and detail, newest first, with line numbers for subagent_get. " +
      'Case-insensitive unless the pattern has an uppercase letter. `pattern: "."` lists the results.',
    parameters: Type.Object({
      pattern: Type.String({ description: "JavaScript regex, matched line by line" }),
      ids: Type.Optional(Type.Array(ID, { minItems: 1, maxItems: MAX_IDS, description: "Search only these agents" })),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Lines of context around each match (default 0)" })),
    }),
    annotations: { readOnlyHint: true },
    async execute(_id, params: { pattern: string; ids?: string[]; context?: number }, _signal, _update, c) {
      let re: RegExp;
      try {
        re = compilePattern(params.pattern);
      } catch (err) {
        throw new Error(`Invalid pattern: ${(err as Error).message}`);
      }
      const only = params.ids && new Set(params.ids.map(parseAgentId).filter((n) => n !== undefined));
      const results = [...index(c)].filter(([n, r]) => r.result && (!only || only.has(n))).map(([, r]) => r.result!);
      return text(formatGrep(grepResults(results, re, params.context ?? 0)));
    },
  } as ToolDefinition<TSchema>);

  // ── /agent ──

  const page = (c: ExtensionContext, id: number): AgentPage => {
    const live = manager.view(id);
    if (live) return { title: liveHeader(live, now()), ...livePage(live, now()), live: true };
    const r = index(c).get(id);
    const result = r?.result ?? r?.end;
    if (result) return { title: resultHeader(result), ...resultPage(result), live: false };
    if (r) return { title: `${agentId(id)} · ${scenarioLabel(r.start.scenario)}`, ...noResultPage(r.start.task), live: false };
    return { title: agentId(id), lines: ["no such subagent on this branch"], live: false };
  };

  const openPanel = (c: ExtensionContext, ids: number[], title: string, start: number) =>
    c.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new AgentViewer(tui, theme, title, ids, (id) => page(c, id), (id) => kill(id, "user", c), () => done(), { start }),
      { overlay: true, overlayOptions: VIEWER_OVERLAY },
    );

  const allIds = (c: ExtensionContext): number[] => [...new Set([...index(c).keys(), ...manager.ids()])].sort((a, b) => a - b);

  pi.registerCommand("agent", {
    description: "Subagents: /agent (browse all) · /agent a3 · /agent grep <regex> · /agent kill a3 · /agent restart a3",
    handler: async (args, c) => {
      ctx = c;
      const [verb = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const arg = rest.join(" ");
      const notifyError = (err: unknown) => c.ui.notify((err as Error).message, "error");
      if (verb === "kill" || verb === "restart") {
        const n = parseAgentId(arg);
        if (n === undefined) return notifyError(new Error(`Usage: /agent ${verb} <id>, e.g. /agent ${verb} a3`));
        try {
          c.ui.notify(verb === "kill" ? await kill(n, "user", c) : restart(c, n, "user"), "info");
        } catch (err) {
          notifyError(err);
        }
        return;
      }
      let ids: number[];
      let title: string;
      let start: number;
      if (verb === "grep") {
        if (!arg) return notifyError(new Error("Usage: /agent grep <regex>"));
        let re: RegExp;
        try {
          re = compilePattern(arg);
        } catch (err) {
          return notifyError(new Error(`Invalid pattern: ${(err as Error).message}`));
        }
        const results = [...index(c).values()].flatMap((r) => (r.result ? [r.result] : []));
        ids = grepResults(results, re).hits.map((h) => parseAgentId(h.resultId)!).reverse();
        title = `/agent grep ${arg}`;
        start = ids.length - 1;
      } else if (verb === "") {
        ids = allIds(c);
        title = "/agent";
        start = ids.length - 1;
      } else {
        const parsed = args.split(/[\s,]+/).filter(Boolean).map((a) => [a, parseAgentId(a)] as const);
        const bad = parsed.find(([, n]) => n === undefined);
        if (bad) return notifyError(new Error(`Not an agent ID: ${bad[0]}. Usage: /agent [a3 ...] · grep <regex> · kill <id> · restart <id>`));
        ids = [...new Set(parsed.map(([, n]) => n!))];
        title = `/agent ${args.trim()}`;
        start = 0;
      }
      if (ids.length === 0) {
        c.ui.notify(verb === "grep" ? "No subagent result matches." : "No subagents on this branch yet.", "info");
        return;
      }
      if (c.mode !== "tui") {
        const shown = verb === "" ? ids.slice(-1) : ids;
        c.ui.notify(shown.map((id) => { const p = page(c, id); return [p.title, ...p.lines].join("\n"); }).join("\n\n"), "info");
        return;
      }
      await openPanel(c, ids, title, start);
    },
  });
}
