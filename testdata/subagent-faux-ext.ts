// pi extension for subagent process tests: a scripted faux model (provider "faux", model "m")
// that answers with FAUX_STEPS (JSON: [{ tool, args } | { text }], one assistant message each),
// and a "slow_tool" that sleeps `ms`, so a child can be kept busy.
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export default function (pi: any) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  const steps: Array<{ tool?: string; args?: Record<string, unknown>; text?: string }> = JSON.parse(process.env.FAUX_STEPS ?? "[]");
  faux.setResponses(
    steps.map((s) => (s.tool ? fauxAssistantMessage(fauxToolCall(s.tool, s.args ?? {}), { stopReason: "toolUse" }) : fauxAssistantMessage(fauxText(s.text ?? "")))),
  );
  pi.registerProvider(faux.provider);
  pi.registerTool({
    name: "slow_tool",
    label: "slow",
    description: "Sleeps",
    parameters: Type.Object({ ms: Type.Number() }),
    async execute(_id: string, p: { ms: number }) {
      await new Promise((r) => setTimeout(r, p.ms));
      return { content: [{ type: "text", text: "slept" }] };
    },
  });
}
