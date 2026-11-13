# Git worktrees

The worktree extension creates git worktrees and can confine a session to one of them.

## Tools and command

| Tool | `/worktree` | Does |
|---|---|---|
| `worktree_list()` | `list` | Worktrees of every repo in the workspace (the cwd's repo and the repos in its direct subfolders). `*` marks the one the session works in: the entered worktree, else the checkout of the cwd. |
| `worktree_add(branch, repo?, base?, enter?)` | `add <branch> [--repo <dir>] [--base <ref>] [--enter]` | Creates `<folder>/<repo>-wt/<branch, / as ->`. Checks out the local branch if it exists, else tracks `<remote>/<branch>`, else creates the branch from `base` (default: HEAD). |
| `worktree_enter(branch, repo?)` | `enter <branch> [--repo <dir>]` | Enters the branch's worktree for the rest of the session. |
| `worktree_remove(branch, repo?)` | `remove <branch> [--repo <dir>]` | Removes the worktree, keeps the branch. Fails with uncommitted changes, or while the session is in it. |
| (none) | `exit` | Leaves the entered worktree. Only the user can. |

- `repo` is a folder relative to the session's cwd (or absolute). Without it: the entered
  worktree's repo, else the repo the cwd is in.
- `worktree_add` also adds `/.pi/` to the repo's `.git/info/exclude`, and gives the worktree a
  `.pi/settings.json` (a copy of the main checkout's, else this session's `project` entry) so
  pi started there finds the project. An existing file is never replaced.

## While a worktree is entered

- Relative paths of `read`, `write`, `edit`, `ls`, `grep` and `find` (no path: the worktree)
  and every `bash` command run in the worktree. Calls from codemode scripts too.
- `write` and `edit` outside the worktree (and the temp folder) are blocked. Reads and bash are not.
- The system prompt gets a `<worktree>` section saying so.
- It is kept in the session: `/resume` and `/tree` restore it. A deleted worktree is left
  with a warning.

## Where worktrees go

The first that is set, in `settings.json` (`~/.pi/agent/settings.json` or `.pi/settings.json`):

1. `"project": { ..., "worktreeDir": "..." }`: relative to a local project's folder, else to the cwd.
2. `"worktree": { "dir": "~/worktrees" }`: relative to the cwd.
3. `.pi/worktree` in the local project's folder (next to `project.yaml`), else in the cwd.

`~` is expanded. An invalid `worktree` entry stops pi with `[pi-agent] <message>`.
