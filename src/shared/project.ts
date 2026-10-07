import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { parse as parseYaml } from "yaml";

/**
 * Project context (docs/project-context-design.md): `project.yaml` in a read-only project
 * folder plus `AGENTS.md` at the workspace root, rendered into "block B" of the system prompt.
 *
 * Used by both the wrapper (validation, report) and the extension (the prompt), so both render
 * the same bytes. Rendering must stay deterministic: the same inputs always give the same text,
 * or the cached prompt prefix changes between runs.
 */

export const PROJECT_FILE = "project.yaml";
export const AGENTS_MD = "AGENTS.md";
/** Block B is re-read on every turn; above this many (estimated) tokens the wrapper warns. */
export const PROJECT_TOKEN_WARNING = 8000;

const Line = Type.String({ minLength: 1, pattern: "^[^\\r\\n]+$" });
const Text = Type.String({ minLength: 1 });
const IndexEntry = Type.Object(
  {
    /** Relative to the project folder. */
    path: Line,
    /** Trigger: when the agent should read the file. */
    when: Line,
  },
  { additionalProperties: false },
);

export const ProjectManifestSchema = Type.Object(
  {
    version: Type.Literal(1),
    name: Line,
    description: Type.Optional(Text),
    /** Short, always-on rules, in order. */
    rules: Type.Optional(Type.Array(Text)),
    /** One-line invocations: exact command → what it does. */
    commands: Type.Optional(Type.Record(Type.String(), Line)),
    /** Step-by-step instructions for one specific task each. Index only. */
    workflows: Type.Optional(Type.Array(IndexEntry)),
    /** Reference material. Index only. */
    docs: Type.Optional(Type.Array(IndexEntry)),
  },
  { additionalProperties: false },
);
export type ProjectManifest = Static<typeof ProjectManifestSchema>;

export interface Project {
  /** Absolute path of the folder containing `project.yaml`, as given (not resolved further). */
  dir: string;
  manifest: ProjectManifest;
}

/** `AGENTS.md` at the workspace root. */
export interface AgentsMd {
  path: string;
  content: string;
}

/** Ordered system prompt sections (tag name → content), as pi's `systemPromptOptions.sections`. */
export type ProjectSections = Record<string, string>;

/** Section names, in prompt order. Prefixed so they can't collide with pi's own sections. */
export const SECTION = {
  project: "project",
  rules: "project_rules",
  agentsMd: "agents_md",
  commands: "project_commands",
  workflows: "project_workflows",
  docs: "project_docs",
} as const;

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

/** Problems with the manifest that the schema can't express (paths, duplicates, keys). */
async function manifestProblems(dir: string, m: ProjectManifest): Promise<string[]> {
  const problems: string[] = [];
  for (const command of Object.keys(m.commands ?? {})) {
    if (command.trim() === "" || /[\r\n]/.test(command)) {
      problems.push(`/commands: command ${JSON.stringify(command)} must be a single non-empty line`);
    }
  }
  const seen = new Map<string, string>();
  for (const key of ["workflows", "docs"] as const) {
    for (const [i, entry] of (m[key] ?? []).entries()) {
      const where = `/${key}/${i}/path`;
      const rel = normalize(entry.path);
      if (isAbsolute(entry.path) || rel === ".." || rel.startsWith(`..${sep}`)) {
        problems.push(`${where}: ${entry.path} must be a relative path inside the project folder`);
        continue;
      }
      const previous = seen.get(rel);
      if (previous) problems.push(`${where}: ${entry.path} is already listed at ${previous}`);
      seen.set(rel, where);
      if (!(await isFile(join(dir, rel)))) problems.push(`${where}: ${entry.path} is not a file`);
    }
  }
  return problems;
}

/**
 * Loads and validates `<dir>/project.yaml`. Throws with every problem listed. With `optional`,
 * a missing `project.yaml` returns undefined instead (an invalid one still throws).
 */
export async function loadProject(dir: string, opts: { optional?: boolean } = {}): Promise<Project | undefined> {
  dir = resolve(dir);
  const file = join(dir, PROJECT_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (opts.optional && (err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`Invalid ${file}: ${(err as Error).message}`);
  }
  if (!Value.Check(ProjectManifestSchema, raw)) {
    // TypeBox reports an unknown key twice: as "<key> schema is false" and as a generic
    // "must not have additional properties" on the parent. Keep one, naming the key.
    const errors = Value.Errors(ProjectManifestSchema, raw)
      .filter((e) => e.keyword !== "additionalProperties")
      .map((e) => `${e.instancePath || "/"} ${e.message === "schema is false" ? "is not a known key" : e.message}`);
    throw new Error(`Invalid ${file}:\n${errors.join("\n")}`);
  }
  const problems = await manifestProblems(dir, raw);
  if (problems.length) throw new Error(`Invalid ${file}:\n${problems.join("\n")}`);
  return { dir, manifest: raw };
}

/** Reads `<cwd>/AGENTS.md`; undefined if it is missing or blank. Nothing else is looked up. */
export async function readAgentsMd(cwd: string): Promise<AgentsMd | undefined> {
  const path = join(cwd, AGENTS_MD);
  const content = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "EISDIR") return undefined;
    throw new Error(`Cannot read ${path}: ${err.message}`);
  });
  return content === undefined || normalizeText(content) === "" ? undefined : { path, content };
}

/**
 * LF line endings, no trailing whitespace on any line, no leading or trailing blank lines.
 * pi adds the newline before the closing tag, so content ends with exactly one newline there.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/** Markdown list item; continuation lines are indented under it. */
function item(text: string): string {
  return `- ${normalizeText(text).replaceAll("\n", "\n  ")}`;
}

function code(command: string): string {
  return command.includes("`") ? `\`\` ${command} \`\`` : `\`${command}\``;
}

/**
 * Block B sections, in prompt order. Keeps the manifest's order everywhere (never sorts) and
 * leaves out empty sections. No generated values (dates, sizes, counts) in the text.
 */
export function renderProjectSections(o: { cwd: string; project?: Project; agentsMd?: AgentsMd }): ProjectSections {
  const sections: ProjectSections = {};
  const m = o.project?.manifest;
  const at = (rel: string) => join(o.project!.dir, normalize(rel));
  if (m) {
    sections[SECTION.project] = [`name: ${m.name}`, ...(m.description ? [normalizeText(m.description)] : [])].join("\n");
    if (m.rules?.length) sections[SECTION.rules] = m.rules.map(item).join("\n");
  }
  if (o.agentsMd) sections[SECTION.agentsMd] = `path: ${o.agentsMd.path}\n${normalizeText(o.agentsMd.content)}`;
  if (m) {
    const commands = Object.entries(m.commands ?? {});
    if (commands.length) {
      sections[SECTION.commands] = [
        `Run from ${o.cwd}:`,
        ...commands.map(([command, what]) => `- ${code(command.trim())}: ${what.trim()}`),
      ].join("\n");
    }
    if (m.workflows?.length) {
      sections[SECTION.workflows] = [
        "Before doing one of these tasks, read its file and follow the steps in order:",
        ...m.workflows.map((w) => `- ${at(w.path)}: ${w.when.trim()}`),
      ].join("\n");
    }
    if (m.docs?.length) {
      sections[SECTION.docs] = [
        "Read a doc when its condition applies:",
        ...m.docs.map((d) => `- ${at(d.path)}: ${d.when.trim()}`),
      ].join("\n");
    }
  }
  return sections;
}

/**
 * Block B exactly as it appears in the system prompt: pi wraps each section in its tag and
 * joins sections with a blank line. Empty string when there are no sections.
 */
export function renderBlock(sections: ProjectSections): string {
  return Object.entries(sections)
    .map(([name, content]) => `<${name}>\n${content}\n</${name}>`)
    .join("\n\n");
}

/** Rough token count (4 characters per token); good enough for size warnings. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export interface ProjectBlockInfo {
  /** Section names, in prompt order. */
  sections: string[];
  /** sha256 of the rendered block: if it differs between runs, the cached prefix did too. */
  sha256: string;
  chars: number;
  approxTokens: number;
}

export function describeBlock(sections: ProjectSections): ProjectBlockInfo {
  const text = renderBlock(sections);
  return {
    sections: Object.keys(sections),
    sha256: createHash("sha256").update(text).digest("hex"),
    chars: text.length,
    approxTokens: estimateTokens(text),
  };
}
