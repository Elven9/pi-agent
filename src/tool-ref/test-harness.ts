import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

/** A pi SDK session with the faux provider, for tool-ref tests. Not part of the extension. */
export interface TestSessionOptions {
  /** Extension factories in load order. */
  extensions: ExtensionFactory[];
  /** Tool allowlist, as `--tools`. */
  tools: string[];
  /** Extension flag values, as on the command line (`{ scenario: "demo" }`). */
  flags?: Record<string, string | boolean>;
  /** Global settings.json content. */
  settings?: object;
  sessionManager?: SessionManager;
  /** Reuse the folders of an earlier session (resume). */
  root?: string;
}

export async function makeSession(opts: TestSessionOptions) {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "tool-ref-test-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (opts.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(opts.settings));
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  modelRuntime.registerNativeProvider(faux.provider);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: opts.extensions,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const sessionManager = opts.sessionManager ?? SessionManager.create(cwd, join(root, "sessions"));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    thinkingLevel: "off",
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
    tools: opts.tools,
  });
  // Flags are parsed before session_start (bindExtensions emits it), as in the CLI.
  for (const [name, value] of Object.entries(opts.flags ?? {})) session.extensionRunner.setFlagValue(name, value);
  await session.bindExtensions({});
  return { session, faux, sessionManager, root, cwd };
}
