import { writeSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getScenario, scenarioNames } from "../shared/scenarios/index.ts";
import overview from "./docs/overview.md";
import project from "./docs/project.md";
import scenario from "./docs/scenario.md";

export const DOCS_FLAG = "pi-agent-docs";

const TOPICS: Record<string, () => string> = {
  overview: () => overview,
  project: () => project,
  scenario: () => `${scenario.trimEnd()}\n\n${scenarioTable()}`,
};
export const TOPIC_NAMES = Object.keys(TOPICS);

/** Generated from the registry, so names, tools and detail kinds never drift from the code. */
export function scenarioTable(): string {
  const rows = scenarioNames().map((name) => {
    const s = getScenario(name);
    return `| \`${name}\` | ${s.tools.join(", ")} | \`${s.detailKind}\` |`;
  });
  return ["## Registered scenarios", "", "| Name | Built-in tools | detailKind |", "|---|---|---|", ...rows, ""].join("\n");
}

/**
 * The flag's value in argv, parsed like pi parses extension flags: `--flag=value`, `--flag value`
 * (next arg not starting with `-` or `@`) or bare `--flag` (true). Stops at `--`.
 */
export function docsRequest(argv: readonly string[]): string | true | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") return undefined;
    if (arg.startsWith(`--${DOCS_FLAG}=`)) return arg.slice(DOCS_FLAG.length + 3);
    if (arg === `--${DOCS_FLAG}`) {
      const next = argv[i + 1];
      return next !== undefined && !next.startsWith("-") && !next.startsWith("@") ? next : true;
    }
  }
  return undefined;
}

/** The docs for a topic (none: the overview), or an error with the known topics. */
export function renderDocs(topic: string | true): { text: string } | { error: string } {
  const name = topic === true || topic === "" ? "overview" : topic;
  const render = Object.hasOwn(TOPICS, name) ? TOPICS[name] : undefined;
  if (!render) return { error: `Unknown docs topic "${name}" (known: ${TOPIC_NAMES.join(", ")})` };
  const text = render().trimEnd();
  return { text: `${text}\n` };
}

export interface DocsIo {
  out(text: string): void;
  err(text: string): void;
  exit(code: number): never | void;
}

/** fd writes: pi redirects process.stdout to stderr outside the TUI (output guard). */
function writeAll(fd: number, text: string) {
  const buf = Buffer.from(text);
  for (let off = 0; off < buf.length; ) {
    try {
      off += writeSync(fd, buf, off);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
    }
  }
}

const processIo: DocsIo = {
  out: (text) => writeAll(1, text),
  err: (text) => writeAll(2, text),
  exit: (code) => process.exit(code),
};

/**
 * Agent docs (personal pi, package manifest). Registers `--pi-agent-docs [topic]`, so it is
 * listed in `pi --help` with a pointer to the docs. With the flag, prints the topic's Markdown
 * (src/agent-docs/docs/, scenario list generated from the registry) to stdout and exits 0
 * (unknown topic: exits 2), before any model, session or TUI starts.
 *
 * pi parses extension flags only after extensions load, so the flag is read from argv here, at
 * load time. A /reload can't see it: with the flag, pi has already exited.
 */
export default function agentDocs(pi: ExtensionAPI, argv: readonly string[] = process.argv.slice(2), io: DocsIo = processIo) {
  pi.registerFlag(DOCS_FLAG, {
    type: "string",
    description: `Print pi-agent usage docs and exit. Topics: ${TOPIC_NAMES.join(", ")}. Read before using --project or --scenario`,
  });
  const topic = docsRequest(argv);
  if (topic === undefined) return;
  const docs = renderDocs(topic);
  if ("error" in docs) {
    io.err(`[pi-agent] ${docs.error}\n`);
    io.exit(2);
    return;
  }
  io.out(docs.text);
  io.exit(0);
}
