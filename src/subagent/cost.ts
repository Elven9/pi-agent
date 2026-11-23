import { readFileSync } from "node:fs";

/**
 * What a child's session cost in USD, summed from its session file as pi's session stats do:
 * assistant messages, `usage` entries (e.g. cache warming) and compaction / branch-summary
 * generation. pi appends entries synchronously, so when the child's last assistant message (the
 * `send_to_leader` call) has ended, the file is complete enough for the result.
 * Undefined when the file cannot be read or records no cost.
 */
export function sessionCost(file: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let total = 0;
  let seen = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const cost = costOf(entry);
    if (cost !== undefined) {
      total += cost;
      seen = true;
    }
  }
  return seen ? total : undefined;
}

function costOf(entry: Record<string, unknown>): number | undefined {
  let usage: unknown;
  if (entry.type === "message") {
    const message = entry.message as { role?: unknown; usage?: unknown } | undefined;
    if (message?.role !== "assistant") return undefined;
    usage = message.usage;
  } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
    usage = entry.usage;
  } else {
    return undefined;
  }
  const total = (usage as { cost?: { total?: unknown } } | undefined)?.cost?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

/** `$0.06`, `$1.24`; below a cent `$0.004`. */
export function formatCost(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}
