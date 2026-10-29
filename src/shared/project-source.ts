import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/**
 * Where a project's files come from (docs/project-context-design.md, "Project source"): a local
 * folder (`--project <dir>`, `PI_AGENT_PROJECT`, or a `local` `project` entry in pi's
 * settings.json) or a GitHub/GitLab repository pinned to a tag (a `github` / `gitlab` entry),
 * read through the logged-in `gh` / `glab` CLI. Every project file is read through
 * `ProjectSource.read`: `project.yaml`, the path checks, and the `project_read` tool.
 */

/** Key of the project entry in pi's settings.json. */
export const PROJECT_SETTING = "project";

const Line = Type.String({ minLength: 1, pattern: "^[^\\r\\n]+$" });

const remoteSchema = <T extends "github" | "gitlab">(type: T) =>
  Type.Object(
    {
      type: Type.Literal(type),
      /** Repository URL, e.g. https://github.com/owner/repo or https://gitlab.example.com/group/sub/repo. */
      repo: Line,
      /** Tag the project is pinned to. Resolved to a commit once per session. */
      tag: Line,
      /** Folder in the repository with `project.yaml` (default: the root). Several projects can share a repo. */
      path: Type.Optional(Line),
    },
    { additionalProperties: false },
  );

const LocalSettingSchema = Type.Object(
  {
    type: Type.Literal("local"),
    /** Folder with `project.yaml`; a relative path is resolved against the working directory pi runs in. */
    dir: Line,
  },
  { additionalProperties: false },
);

/** The `project` entry's schema for each `type`. `type` is checked first, then its own keys. */
export const PROJECT_SETTING_SCHEMAS = {
  github: remoteSchema("github"),
  gitlab: remoteSchema("gitlab"),
  local: LocalSettingSchema,
};
export type ProjectType = keyof typeof PROJECT_SETTING_SCHEMAS;
export type LocalSetting = Static<typeof LocalSettingSchema>;
export type RemoteSetting = Static<(typeof PROJECT_SETTING_SCHEMAS)["github" | "gitlab"]>;
export type ProjectSetting = LocalSetting | RemoteSetting;
export type Provider = RemoteSetting["type"];

/** A remote project's coordinates, with the tag resolved to a commit. */
export interface RemoteProject {
  provider: Provider;
  /** Normalized repository URL: https://<host>/<path>. */
  repo: string;
  host: string;
  /** Repository path on the host: owner/repo (GitHub) or group/.../repo (GitLab). */
  repoPath: string;
  /** Project folder in the repository (normalized); absent for the root. */
  path?: string;
  tag: string;
  /** Commit the tag pointed to when the session started; every read uses it. */
  commit: string;
}

export interface ProjectSource {
  readonly kind: "local" | "remote";
  /** For messages, `/project` and `/context`: the folder, or `<repo>@<tag>`. */
  readonly label: string;
  /** Local folder (absolute); undefined for a remote project. */
  readonly dir?: string;
  readonly remote?: RemoteProject;
  /**
   * Content of a file, by its path relative to the project root (checked with `projectPath`).
   * Undefined when there is no such file (missing, or a directory). Other failures throw.
   */
  read(path: string): Promise<string | undefined>;
}

/**
 * Normalized project-relative path (POSIX separators), or undefined when it is not a path inside
 * the project (absolute, empty, or leading out with `..`).
 */
export function projectPath(path: string): string | undefined {
  const rel = posix.normalize(path.replaceAll("\\", "/"));
  if (posix.isAbsolute(rel) || rel === "." || rel === ".." || rel.startsWith("../")) return undefined;
  return rel.replace(/\/$/, "");
}

export function localSource(dir: string): ProjectSource {
  return {
    kind: "local",
    label: dir,
    dir,
    async read(path) {
      const file = join(dir, path);
      return readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || err.code === "EISDIR" || err.code === "ENOTDIR") return undefined;
        throw new Error(`Cannot read ${file}: ${err.message}`);
      });
    },
  };
}

/**
 * The `project` entry from pi's merged settings; undefined without one. Throws when invalid.
 * `type` is checked first, so the errors are about the keys of that type only.
 */
export function projectSetting(settings: unknown): ProjectSetting | undefined {
  const raw = (settings as Record<string, unknown> | undefined)?.[PROJECT_SETTING];
  if (raw === undefined) return undefined;
  const invalid = (errors: string[]) => new Error(`Invalid "${PROJECT_SETTING}" in settings.json:\n${errors.join("\n")}`);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid(["/ must be an object"]);
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string" || !Object.hasOwn(PROJECT_SETTING_SCHEMAS, type)) {
    const got = type === undefined ? "is missing" : `is ${JSON.stringify(type)}`;
    throw invalid([`/type must be one of ${Object.keys(PROJECT_SETTING_SCHEMAS).join(", ")} (${got})`]);
  }
  const schema = PROJECT_SETTING_SCHEMAS[type as ProjectType];
  if (!Value.Check(schema, raw)) {
    const errors = Value.Errors(schema, raw)
      .filter((e) => e.keyword !== "additionalProperties")
      .map((e) => `${e.instancePath || "/"} ${e.message === "schema is false" ? "is not a known key" : e.message}`);
    throw invalid(errors);
  }
  const setting = raw as ProjectSetting;
  if (setting.type !== "local") {
    parseRepo(setting);
    projectFolder(setting);
  }
  return setting;
}

/**
 * Source for a valid setting: a `local` folder (relative `dir` resolved against `cwd`, the
 * working directory pi runs in) or the remote repository.
 */
export async function settingSource(setting: ProjectSetting, cwd: string, run: CliRunner = execCli): Promise<ProjectSource> {
  return setting.type === "local" ? localSource(resolve(cwd, setting.dir)) : remoteSource(setting, run);
}

/** The setting's project folder, normalized; undefined for the repository root. */
export function projectFolder(setting: RemoteSetting): string | undefined {
  if (setting.path === undefined) return undefined;
  const path = setting.path.trim();
  if (path === "." || path === "/") return undefined;
  const folder = projectPath(path);
  if (folder === undefined) {
    throw new Error(`Invalid "${PROJECT_SETTING}" in settings.json: /path ${setting.path} must be a folder inside the repository`);
  }
  return folder;
}

/** Host and repository path from the setting's URL. */
export function parseRepo(setting: RemoteSetting): { repo: string; host: string; repoPath: string } {
  const bad = (why: string) => new Error(`Invalid "${PROJECT_SETTING}" in settings.json: /repo ${why}`);
  let url: URL;
  try {
    url = new URL(setting.repo);
  } catch {
    throw bad(`must be a repository URL (https://<host>/<path>), got ${JSON.stringify(setting.repo)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw bad("must be an http(s) URL");
  if (url.search || url.hash || url.username || url.password) throw bad("must not have a query, fragment or credentials");
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const segments = path.split("/");
  if (path === "" || segments.some((s) => s === "")) throw bad("has no repository path");
  if (setting.type === "github" && segments.length !== 2) throw bad("must be https://<host>/<owner>/<repo> for GitHub");
  return { repo: `https://${url.host}/${path}`, host: url.host, repoPath: path };
}

/** Runs a CLI and returns its stdout; rejects with `CliError` when it fails. */
export type CliRunner = (command: string, args: string[]) => Promise<string>;

export class CliError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

const CLI_TIMEOUT_MS = 60_000;

export const execCli: CliRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 256 * 1024 * 1024, timeout: CLI_TIMEOUT_MS, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return reject(new CliError(`${command} is not installed (or not on PATH)`, ""));
      }
      // gh prints the API's JSON body on stdout and its summary on stderr.
      const detail = [stderr, stdout].map((s) => s.trim()).filter(Boolean).join("\n");
      reject(new CliError(`${command} ${args.join(" ")} failed: ${detail || err.message}`, `${stderr}\n${stdout}`));
    });
  });

const isNotFound = (err: unknown) => err instanceof CliError && /\b404\b/.test(err.stderr);

/** URL-encodes each segment, keeping the slashes. */
const encodeSegments = (path: string) => path.split("/").map(encodeURIComponent).join("/");

interface Api {
  cli: string;
  /** Commit of the tag; rejects when the tag does not exist. */
  resolveTag(tag: string): Promise<string>;
  /** File content at the commit; undefined when there is no such file. */
  read(path: string, commit: string): Promise<string | undefined>;
}

function decode(body: { content?: unknown; encoding?: unknown }): string | undefined {
  if (typeof body.content !== "string") return undefined;
  return body.encoding === "base64" ? Buffer.from(body.content, "base64").toString("utf8") : body.content;
}

function githubApi(run: CliRunner, host: string, repoPath: string): Api {
  const api = (endpoint: string, ...extra: string[]) => run("gh", ["api", "--hostname", host, endpoint, ...extra]);
  return {
    cli: "gh",
    async resolveTag(tag) {
      // refs/tags/ so a branch with the same name is never used.
      return (await api(`repos/${repoPath}/commits/refs/tags/${encodeSegments(tag)}`, "--jq", ".sha")).trim();
    },
    async read(path, commit) {
      const endpoint = `repos/${repoPath}/contents/${encodeSegments(path)}?ref=${commit}`;
      let body: unknown;
      try {
        body = JSON.parse(await api(endpoint));
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
      // A directory is an array; symlinks and submodules are not project files.
      if (Array.isArray(body) || (body as { type?: unknown }).type !== "file") return undefined;
      const b = body as { content?: unknown; encoding?: unknown };
      // Files over 1 MB come without content ("encoding": "none"): fetch them raw.
      return b.encoding === "base64" ? decode(b) : api(endpoint, "-H", "Accept: application/vnd.github.raw");
    },
  };
}

function gitlabApi(run: CliRunner, host: string, repoPath: string): Api {
  const project = `projects/${encodeURIComponent(repoPath)}`;
  const api = async (endpoint: string) =>
    JSON.parse(await run("glab", ["api", "--hostname", host, endpoint])) as Record<string, unknown>;
  return {
    cli: "glab",
    async resolveTag(tag) {
      const body = await api(`${project}/repository/tags/${encodeURIComponent(tag)}`);
      const id = (body.commit as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string") throw new Error(`unexpected tag response: ${JSON.stringify(body).slice(0, 200)}`);
      return id;
    },
    async read(path, commit) {
      try {
        // 404 for directories too.
        return decode(await api(`${project}/repository/files/${encodeURIComponent(path)}?ref=${commit}`));
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
    },
  };
}

/**
 * Remote project source: resolves the tag to a commit once (so a moved tag can't mix versions
 * within a session), then reads files at that commit. Reads are cached for the session.
 */
export async function remoteSource(setting: RemoteSetting, run: CliRunner = execCli): Promise<ProjectSource> {
  const { repo, host, repoPath } = parseRepo(setting);
  const folder = projectFolder(setting);
  const api = setting.type === "github" ? githubApi(run, host, repoPath) : gitlabApi(run, host, repoPath);
  const label = `${repo}${folder ? `/${folder}` : ""}@${setting.tag}`;
  let commit: string;
  try {
    commit = await api.resolveTag(setting.tag);
  } catch (err) {
    const why = isNotFound(err) || /\b422\b/.test((err as CliError).stderr ?? "")
      ? `tag ${setting.tag} not found`
      : (err as Error).message;
    throw new Error(`Cannot open project ${label} with ${api.cli} (logged in? \`${api.cli} auth status --hostname ${host}\`): ${why}`);
  }
  if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new Error(`Cannot open project ${label}: unexpected commit "${commit}"`);
  const cache = new Map<string, Promise<string | undefined>>();
  return {
    kind: "remote",
    label,
    remote: { provider: setting.type, repo, host, repoPath, ...(folder && { path: folder }), tag: setting.tag, commit },
    // `file` is relative to the project folder.
    read(file) {
      let content = cache.get(file);
      if (!content) {
        content = api.read(folder ? `${folder}/${file}` : file, commit).catch((err: Error) => {
          cache.delete(file); // a failure (network, auth) may succeed on retry; "not found" is cached
          throw new Error(`Cannot read ${file} from ${label}: ${err.message}`);
        });
        cache.set(file, content);
      }
      return content;
    },
  };
}
