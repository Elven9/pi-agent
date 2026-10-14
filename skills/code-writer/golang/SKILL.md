---
name: golang
description: Conventions and workflow for writing Go code. Use when writing, changing or testing code in any Go project (a go.mod file or .go sources).
---

# Golang Pro

Senior Go developer with deep expertise in Go 1.26+, concurrent programming, and cloud-native microservices. Specializes in idiomatic patterns, performance optimization, and production-grade systems.

## Project Instructions First

Before writing code, look for the project's own instructions and docs and read the parts
that apply. These include project context in your prompt, `AGENTS.md`/`CLAUDE.md`,
`CONTRIBUTING.md`, the `README`, `docs/`, the `Makefile` and linter configs
(`.golangci.yml`). They **take priority over this skill**, including its references (e.g.
Go version, layout, Viper). The user's explicit request takes priority over both. If they
conflict, follow the higher one and mention the conflict.

## Go Version

Use Go **1.26+** whenever possible.

**New project (setup phase):** before `go mod init`, run `go version`.

- 1.26 or newer: set the `go` directive in `go.mod` to the installed version (at least `go 1.26`).
- Older than 1.26, or Go not installed: **tell the user**. Name the installed version (or say
  Go is missing) and recommend 1.26+ from https://go.dev/dl/ or the package manager, e.g.
  `brew upgrade go`. Then continue with the installed version and set the `go` directive to
  it. Don't set a newer `go` directive than the installed Go: that makes Go download a
  toolchain, which can fail offline or in a sandbox. Don't install or upgrade Go yourself
  unless the user asks.
- In a run without a chat (no one to answer), put this notice in the final summary.

**Existing project:** keep the `go` directive in `go.mod`, and only use language and standard
library features that version supports. Don't raise the directive unless the user asks. If
raising it would help, suggest it.

## Core Workflow

1. **Analyze architecture** — Review module structure, interfaces, and concurrency patterns
2. **Design interfaces** — Create small, focused interfaces with composition
3. **Implement** — Write idiomatic Go with proper error handling and context propagation; run `go vet ./...` before proceeding
4. **Lint & validate** — Run `golangci-lint run` and fix all reported issues before proceeding
5. **Optimize** — Profile with pprof, write benchmarks, eliminate allocations
6. **Test** — Table-driven tests with `-race` flag, fuzzing, 80%+ coverage; confirm race detector passes before committing

## Reference Guide

Load detailed guidance based on context:

| Topic             | Reference                         | Load When                                                       |
| ----------------- | --------------------------------- | --------------------------------------------------------------- |
| Project Structure | `references/project-structure.md` | Module layout, internal packages, go.mod, configuration (Viper) |
| Code Pattern      | `references/pattern.md`           | Writing clean codes                                             |
