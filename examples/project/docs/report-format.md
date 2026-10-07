# report.json

Written last and atomically to `<out>/report.json`; its presence means the run is done. The
contract is `src/shared/report.ts` (`REPORT_VERSION = 1`).

| Field | Content |
|---|---|
| `status` | `ok` (valid result), `no_result` (none submitted), `error` (see `errors`) |
| `result` | `summary`, `detailKind`, scenario-specific `detail`; null without a result |
| `metrics` | wall time and phases, tokens, cost, turns, model latency, tools, retries, compactions, context peak, `cacheMisses` |
| `projectContext` | project folder and name, prompt sections, size and `sha256` of block B; null without project context |
| `toolCalls` | every tool call in start order, strings truncated |
| `session` | pi session id and file (relative to the out folder) |
| `errors`, `warnings` | wrapper-level problems |

Compatibility: consumers read version 1. Add fields; don't rename, remove or change the type of
existing ones without bumping `REPORT_VERSION`.
