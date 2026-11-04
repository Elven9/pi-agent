import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  PROJECT_CHANNEL,
  SCENARIO_CHANNEL,
  SKILLS_CHANNEL,
  type ProjectAnnounced,
  type ScenarioSelected,
  type SkillsAnnounced,
} from "../shared/protocol.ts";

/** Widget key (pi keeps one widget per key). */
export const WIDGET_KEY = "pi-agent.activation";

/**
 * Activation hint (personal pi, TUI only). After session start, shows a widget above the editor
 * with the active scenario (`--scenario`), the project (`--project` or settings.json) and the
 * skills the prompts get (the final list after the scenario's and the project's selection,
 * announced by the scenario profile extension), one per line, in a bordered box (boxLines).
 * Without a scenario and a project it still lists the skills. In a fresh session the chat is
 * empty, so the widget sits right under pi's header.
 *
 * UI only: a widget is neither written to the session nor sent to the model (no appendEntry,
 * no sendMessage, no prompt changes). It is cleared when the first prompt starts, so it doesn't
 * stay pinned to the editor, and replaced at every session start.
 *
 * All three are announced from the session_start of the scenario-profile and project
 * extensions, so this extension must load after them: pi runs session_start handlers in load
 * order, each awaited before the next.
 */
export default function activationHint(pi: ExtensionAPI) {
  let scenario: string | undefined;
  let project: ProjectAnnounced["project"];
  let skills: SkillsAnnounced | undefined;
  /** The widget is showing (cleared once, on the first prompt). */
  let shown = false;

  pi.events.on(SCENARIO_CHANNEL, (data) => {
    scenario = (data as ScenarioSelected).name;
  });
  // Also announced on every prompt; only the state at session start is used.
  pi.events.on(PROJECT_CHANNEL, (data) => {
    project = (data as ProjectAnnounced).project;
  });
  // The last announcement before our session_start is the final list.
  pi.events.on(SKILLS_CHANNEL, (data) => {
    skills = data as SkillsAnnounced;
  });

  pi.on("session_start", (_event, ctx) => {
    const rows = activationRows(scenario, project, skills);
    // Announcements are per session start: a new/resumed session announces again.
    scenario = undefined;
    project = undefined;
    skills = undefined;
    if (ctx.mode !== "tui") return;
    shown = rows.length > 0;
    ctx.ui.setWidget(WIDGET_KEY, shown ? (_tui, theme) => activationBox(rows, theme) : undefined);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!shown) return;
    shown = false;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}

/** Space around the box: columns left and right, lines above and below. */
export const MARGIN = { x: 2, y: 1 } as const;
/** Box title, in the top border. */
export const TITLE = "pi-agent";

/** One line of the widget. `tone`: how the value is coloured; `item`: a list entry under the previous row. */
export interface ActivationRow {
  label: string;
  value: string;
  detail?: string;
  tone?: "normal" | "warning";
  item?: boolean;
}

/**
 * The widget's lines, or none when there is nothing to show: the scenario and project, then the
 * skills the prompts get (the final list, in prompt order) one per line with their
 * descriptions, then project skills that are not installed.
 */
export function activationRows(
  scenario?: string,
  project?: ProjectAnnounced["project"],
  skills?: SkillsAnnounced,
): ActivationRow[] {
  const rows: ActivationRow[] = [];
  if (scenario) rows.push({ label: "Scenario", value: scenario, detail: "its system prompt, tools and skills are active" });
  if (project) rows.push({ label: "Project", value: project.name, detail: `${project.dir} · /project shows its context` });
  if (skills) {
    const n = skills.skills.length;
    rows.push({ label: "Skills", value: n ? `${n} active` : "none" });
    for (const name of skills.skills) {
      const description = skills.descriptions?.[name]?.replace(/\s+/g, " ").trim();
      rows.push({ label: "", value: name, ...(description && { detail: description }), item: true });
    }
    if (skills.missing.length) {
      rows.push({ label: "Missing", value: skills.missing.join(", "), detail: "in project.yaml skills, not installed; skipped", tone: "warning" });
    }
  }
  return rows;
}

/** The box's content lines: labels aligned in one column; value, then the detail dimmed. */
export function renderRows(rows: readonly ActivationRow[], theme: Pick<Theme, "fg" | "bold">): string[] {
  const width = Math.max(...rows.map((r) => r.label.length));
  return rows.map((r) => {
    const label = r.item ? " ".repeat(width) : theme.fg("accent", theme.bold(r.label.padEnd(width)));
    const text = r.item ? `${theme.fg("muted", "•")} ${r.value}` : r.value;
    const value = r.tone === "warning" ? theme.fg("warning", text) : text;
    const detail = r.detail ? `${r.item ? "  " : " "}${theme.fg("dim", r.item ? r.detail : `· ${r.detail}`)}` : "";
    return `${label}  ${value}${detail}`;
  });
}

/**
 * `content` in a rounded border with the title, indented by MARGIN and with a blank column of
 * padding inside. Lines wider than the box are cut with "…". Too narrow a terminal: no box.
 */
export function boxLines(content: readonly string[], width: number, theme: Pick<Theme, "fg" | "bold">): string[] {
  const outer = width - 2 * MARGIN.x;
  const inner = outer - 4; // two border columns, one padding column on each side
  if (inner < 10) return content.map((line) => truncateToWidth(line, Math.max(width, 1), "…"));
  const pad = " ".repeat(MARGIN.x);
  const border = (s: string) => theme.fg("border", s);
  const title = ` ${theme.fg("accent", theme.bold(TITLE))} `;
  const top = border("╭─") + title + border(`${"─".repeat(Math.max(outer - 3 - visibleWidth(title), 0))}╮`);
  const body = content.map((line) => {
    const cut = truncateToWidth(line, inner, "…");
    return `${border("│")} ${cut}${" ".repeat(Math.max(inner - visibleWidth(cut), 0))} ${border("│")}`;
  });
  const bottom = border(`╰${"─".repeat(outer - 2)}╯`);
  const blank = Array.from({ length: MARGIN.y }, () => "");
  return [...blank, ...[top, ...body, bottom].map((line) => pad + line), ...blank];
}

/** The widget: rendered for the current width on every draw (theme changes included). */
function activationBox(rows: readonly ActivationRow[], theme: Theme): Component {
  return {
    render: (width) => boxLines(renderRows(rows, theme), width, theme),
    invalidate() {},
  };
}
