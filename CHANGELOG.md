# Changelog

## [0.9.0](https://github.com/Elven9/pi-agent/compare/v0.8.0...v0.9.0) (2026-11-11)


### Features

* **project:** always add the commands section when a justfile and just are present ([9a9b810](https://github.com/Elven9/pi-agent/commit/9a9b810ca19300d4a122df7891a6f725af8a7d37))
* **project:** append the commands after pi's own context files ([7a72be9](https://github.com/Elven9/pi-agent/commit/7a72be9f6f5886e3d35c28737f8f7be323ef61c2))
* **scenario-profile:** register the scenario's MCP servers; code-writer gets gopls ([1233b8f](https://github.com/Elven9/pi-agent/commit/1233b8fbfcf9aaf3cb14e9b622733f08435b3cd1))
* **scenarios:** MCP server presets, starting with gopls ([5f724dc](https://github.com/Elven9/pi-agent/commit/5f724dcaf6d4e4b49af255c155fe429439109222))
* **skills:** golang skill uses the gopls MCP tools when available ([424def0](https://github.com/Elven9/pi-agent/commit/424def0a1b3cd219cd874251281b3dfd4feca16f))
* **wrapper:** load built-in MCP for scenarios with MCP servers; report mcpServers ([f9ed4fb](https://github.com/Elven9/pi-agent/commit/f9ed4fb57315295b8a0374c27365f672d45e06b9))


### Bug Fixes

* **project:** run each justfile on its own instead of merging them ([26cf28e](https://github.com/Elven9/pi-agent/commit/26cf28eb85423995c9b7d6fe23a9bed4ebf90dc1))
* **project:** skip just commands with a warning when just is not installed ([7295152](https://github.com/Elven9/pi-agent/commit/7295152d53da8fbd41ff07f3072d865028514710))

## [0.8.0](https://github.com/Elven9/pi-agent/compare/v0.7.1...v0.8.0) (2026-11-09)


### Features

* **scenarios:** add debugger scenario that proposes a bug's root cause without changing code ([7a9a6fc](https://github.com/Elven9/pi-agent/commit/7a9a6fc0ddefdedd90cf04ecc2b18ff954ef28cf))
* **scenarios:** debugger can gather facts without a root cause (debugger/v2: findings, optional rootCause) ([0808d7b](https://github.com/Elven9/pi-agent/commit/0808d7b348d39b50597dad35f01f77f01873dd17))
* **tool-ref:** copy a call's output or input to the clipboard from the /ref panel ([952b6f4](https://github.com/Elven9/pi-agent/commit/952b6f4b79de8850242b5aec288775dacfc57f22))

## [0.7.1](https://github.com/Elven9/pi-agent/compare/v0.7.0...v0.7.1) (2026-11-06)


### Bug Fixes

* **scenario-profile:** concise global rules; precedence line only with rules ([d7399bf](https://github.com/Elven9/pi-agent/commit/d7399bf9c71a810dd0b7a9f173dabb2b314d5a49))

## [0.7.0](https://github.com/Elven9/pi-agent/compare/v0.6.0...v0.7.0) (2026-11-06)


### Features

* **project:** read AGENTS.md from the workspace's parent folders too ([bb2f44f](https://github.com/Elven9/pi-agent/commit/bb2f44fedd40b6a08feb2d8b7eae148a330bf545))
* **skills:** add shared pi-agent-usage skill ([e275462](https://github.com/Elven9/pi-agent/commit/e27546257c2e9ef17490c5f872e7cea13dd21d4c))
* **tool-ref:** /ref without arguments pages through all calls, newest first ([1dddebb](https://github.com/Elven9/pi-agent/commit/1dddebbe2468d5d22d66a767ce0eddd7b53af4e4))
* **tool-ref:** shift+←/→ jump to the first/last call in the /ref panel ([c1de05a](https://github.com/Elven9/pi-agent/commit/c1de05a03ad93055cf9b44940d6d55a23a142e17))

## [0.6.0](https://github.com/Elven9/pi-agent/compare/v0.5.0...v0.6.0) (2026-11-04)


### Features

* **activation-hint:** bordered startup widget with the final skills list, cleared on the first prompt ([5de39c2](https://github.com/Elven9/pi-agent/commit/5de39c2dc49beb4244696d351fa24d3dc4476c44))
* **activation-hint:** list the active skills, also without scenario or project ([b4d2b1e](https://github.com/Elven9/pi-agent/commit/b4d2b1e01c1211dd4515a9d6c06fa9ec55cc97aa))
* **agent-docs:** --pi-agent-docs [topic] prints usage docs for agents and exits ([2a24880](https://github.com/Elven9/pi-agent/commit/2a24880b52eb88c80c61693359f9b87640ca648c))
* **agent-docs:** load from the package manifest (personal pi) ([853e3b1](https://github.com/Elven9/pi-agent/commit/853e3b1ae5173d129069b0a55b7aceea1e7f40ec))
* **project:** skills.include in project.yaml, announced with the project ([57fe63a](https://github.com/Elven9/pi-agent/commit/57fe63a163e7b6f17037755b81de50f1281cce47))
* **scenario-profile:** apply the project's skills and announce the active skills ([042a637](https://github.com/Elven9/pi-agent/commit/042a63731050ced3db896bee83c35013f0bfe160))
* **scenario-profile:** skill descriptions in the skills announcement ([45fadc8](https://github.com/Elven9/pi-agent/commit/45fadc80886f2846698681e979f0ef91c45a5cfb))
* **wrapper:** pass the project's skills to sandbox runs, warn about missing ones ([280bd8e](https://github.com/Elven9/pi-agent/commit/280bd8ed2da13ddb3e1a0bf63b4f89a296ba4a3e))

## [0.5.0](https://github.com/Elven9/pi-agent/compare/v0.4.0...v0.5.0) (2026-11-02)


### ⚠ BREAKING CHANGES

* **project:** the "commands" key of project.yaml is removed (it is now an error); move the commands to recipes in a justfile next to project.yaml.
* **project:** "provider" is replaced by "type" in the settings.json "project" entry, and PI_AGENT_PROJECT with a project.yaml now wins over the entry.

### Features

* **herdr-session-name:** herdr CLI calls that never throw ([846c4f6](https://github.com/Elven9/pi-agent/commit/846c4f6fa8d99afc68a9fe68034f7b4dfbf8d8fe))
* **herdr-session-name:** latest-wins sync with generic retry and clear ([acf352c](https://github.com/Elven9/pi-agent/commit/acf352c636b1c7c73a29584dd08a5c9755cfe91a))
* **herdr-session-name:** name helpers for herdr labels ([3a79c50](https://github.com/Elven9/pi-agent/commit/3a79c50670540f044b00f64a2f00f18268c59e8d))
* **herdr-session-name:** show the pi session name in herdr ([154f2ef](https://github.com/Elven9/pi-agent/commit/154f2ef71fee7e17d44d92af07b76bb5df5567f5))
* **project:** project commands are just recipes from the project and workspace justfiles ([f663bed](https://github.com/Elven9/pi-agent/commit/f663bed23e20e6bafa1467a0fb5ef40cb512b742))
* **project:** typed project entry in settings.json, with local folders ([0d5ff8f](https://github.com/Elven9/pi-agent/commit/0d5ff8f09ba1806a6170acab146c7885fceffe50))
* **scenario-profile:** global rules from rules/global.md in a &lt;global_rules&gt; section ([bd814a1](https://github.com/Elven9/pi-agent/commit/bd814a14dd0b7751fec59d987dcee8e9b87d6e1e))
* **scenarios:** add the-sculptor scenario for design discussions ([956367b](https://github.com/Elven9/pi-agent/commit/956367b6a1c60603fb6b7d0c90f1d73bf0a3cab5))
* **scenarios:** scenario rules from rules/&lt;name&gt;.md, embedded as is in &lt;rules&gt; ([b5a83f1](https://github.com/Elven9/pi-agent/commit/b5a83f1c756683ab828f111af0b8fe371c8183f9))
* **tags:** --tags flag and /tags command record session tags ([276bcbb](https://github.com/Elven9/pi-agent/commit/276bcbb41c27f2939eee771a98c869caeaac541d))
* **tags:** shared session tag parsing and session-file reader ([a1f9466](https://github.com/Elven9/pi-agent/commit/a1f9466848c6302643503eb4915ab253c052050e))
* **tags:** show tags left of the cwd in the footer, dimmed like it ([b607ad9](https://github.com/Elven9/pi-agent/commit/b607ad916d155ab24190c0f6fe95d94361601b65))
* **wrapper:** task.json tags recorded in the run's session ([73dc2ca](https://github.com/Elven9/pi-agent/commit/73dc2ca987c8d09927d98807e7ace8223ab8622d))

## [0.4.0](https://github.com/Elven9/pi-agent/compare/v0.3.0...v0.4.0) (2026-10-28)


### Features

* **scenario-profile:** global rules in &lt;rules&gt;, with or without a scenario ([f263133](https://github.com/Elven9/pi-agent/commit/f2631336486ab3d90f91cbd7cf08bf1da14134d2))
* **scenario-profile:** scenarios can set their own rules, first in &lt;rules&gt; ([1ea0c16](https://github.com/Elven9/pi-agent/commit/1ea0c16fe26c495391ba7f36e419037bd6a16f38))

## [0.3.0](https://github.com/Elven9/pi-agent/compare/v0.2.0...v0.3.0) (2026-10-27)


### Features

* **activation-hint:** startup notification when a scenario or project is active ([01bc53e](https://github.com/Elven9/pi-agent/commit/01bc53e9cdec300452eafb4234ad9443f9f8b1ec))
* **context-view:** /context opens a scrollable, highlighted panel split by prompt section ([5bd9520](https://github.com/Elven9/pi-agent/commit/5bd9520d1f4485750fb16cdbdcb42852a0ec0162))
* **skills:** scenarios include external skills by name; others are excluded ([9b2aea9](https://github.com/Elven9/pi-agent/commit/9b2aea9aa106ea2b1e51d3565a40e8d5011e5fc2))


### Bug Fixes

* **context-view:** show the system prompt recorded in the session, not pi's base prompt ([42cfec1](https://github.com/Elven9/pi-agent/commit/42cfec1bf3124a831993c6c1d55098fe8e14afa4))

## [0.2.0](https://github.com/Elven9/pi-agent/compare/v0.1.0...v0.2.0) (2026-10-25)


### Features

* **context-view:** add /context: show the full context setup in every session ([6cc57a6](https://github.com/Elven9/pi-agent/commit/6cc57a622350be51a15bbe2d9cb701cf2ea78b36))
* **docker:** compact the 1M-context models at about 200k tokens ([d5008d8](https://github.com/Elven9/pi-agent/commit/d5008d8601381026693303489f5cb8e08fdb6add))
* installable releases (pi install git:github.com/Elven9/pi-agent@vX.Y.Z) ([f692972](https://github.com/Elven9/pi-agent/commit/f692972a9d50bf474f5b957206d1f63294a32d86))
* **metrics:** add a metrics extension that writes pi-agent.metrics entries to the session ([2121ce0](https://github.com/Elven9/pi-agent/commit/2121ce086cb1ca1d792ac559b63c1d215f0f6c5c))
* **openshell:** add the OpenShell sandbox policy to the image ([f1d7464](https://github.com/Elven9/pi-agent/commit/f1d746446bdcdb9aa75a33e20e9f34a8d582d5fe))
* **openshell:** mount the project folder read-only in OpenShell ([4750b24](https://github.com/Elven9/pi-agent/commit/4750b24266de2d4f62ebe1abe8d268bbe551fb18))
* **project:** add cli_tools to project.yaml ([004d789](https://github.com/Elven9/pi-agent/commit/004d789eaf539c30f4cd03e4bfcfe73b64db2c53))
* **project:** add project.yaml loading and block B rendering ([de6c196](https://github.com/Elven9/pi-agent/commit/de6c1960e51b1a7681c5fcd7f58574b9585c078b))
* **project:** add the project context extension ([8e38522](https://github.com/Elven9/pi-agent/commit/8e38522070c9423bc6963334b737f337b86afc6b))
* **project:** load the project extension in personal pi; --project turns off context files ([ec5f2f8](https://github.com/Elven9/pi-agent/commit/ec5f2f8016a310a2451cf81bbc42e92cfb749f50))
* **project:** remote project from GitHub/GitLab via gh/glab, project_read tool ([e50f392](https://github.com/Elven9/pi-agent/commit/e50f392bc687f319627a8c5c0506c36620454afa))
* **project:** split the system prompt into cached blocks A and B ([9471786](https://github.com/Elven9/pi-agent/commit/94717867abc092ee676fcea740ccb07307839f2e))
* **project:** tell the agent several workflows and docs can apply to one task ([1c01809](https://github.com/Elven9/pi-agent/commit/1c01809c95cf6f5195dfd546c638117204c0d50f))
* **report:** ref field with the tool-ref handle of each call ([28adfa1](https://github.com/Elven9/pi-agent/commit/28adfa1d37e49a02b05d35d8160d583c7bad32e2))
* **report:** report prompt cache misses per request ([ee4862f](https://github.com/Elven9/pi-agent/commit/ee4862fef789a860e7e5122c29bfec6e456ef1a9))
* **runner:** add the runner extension ([2c74870](https://github.com/Elven9/pi-agent/commit/2c74870f1185545fbd015d8da6f74daeeab45b2f))
* **scenario-profile:** add a scenario profile extension for the runner and personal pi ([61dae54](https://github.com/Elven9/pi-agent/commit/61dae54f578b49c6b8796e97e6b27677c18c3928))
* **scenarios:** add a code-writer scenario ([7cdc534](https://github.com/Elven9/pi-agent/commit/7cdc5341efd5aec728df0b77305cd8e206844295))
* **scenarios:** add the work-request-triage scenario ([e0d3c9d](https://github.com/Elven9/pi-agent/commit/e0d3c9d090c26c71ef398aa2b80f09a40c371063))
* **scenarios:** codemode in every scenario, ready for codemode.mode "only" ([f12c7c1](https://github.com/Elven9/pi-agent/commit/f12c7c19c7bf9337e38430abb8c6fd0607a05e1d))
* **scenarios:** load scenario system prompts from Markdown files ([bf5db7c](https://github.com/Elven9/pi-agent/commit/bf5db7cb9a2bcee4886970371ea40cef1de40e44))
* **session-upload:** add a session upload extension for personal pi ([829c7b7](https://github.com/Elven9/pi-agent/commit/829c7b7a0c2a8baa4320964a729c9c567d37815b))
* **shared:** add shared contracts: task, scenarios, result envelope, report ([df2f3de](https://github.com/Elven9/pi-agent/commit/df2f3de98247cba2827609d3d4270c907f6f738e))
* **skills:** add code-writer skills with a golang skill ([18e759c](https://github.com/Elven9/pi-agent/commit/18e759c305193ddc0065a37d4233e1ee0d9a3502))
* **skills:** add skill discovery for shared and scenario skills ([7be3ad1](https://github.com/Elven9/pi-agent/commit/7be3ad1178ceecfe7039b861de8347337bbbdf58))
* **skills:** add skill groups for shared skills organized in folders ([7d40e75](https://github.com/Elven9/pi-agent/commit/7d40e75f91438ecac2c53c8e72a5d8f698a96254))
* **tool-ref:** /ref command to view calls by handle ([cdb142d](https://github.com/Elven9/pi-agent/commit/cdb142d1b8445a74e17ac6a1d0f0908dfa400774))
* **tool-ref:** /ref sections as blocks marking code and its language ([9ee37f6](https://github.com/Elven9/pi-agent/commit/9ee37f69a1aefd950103dc218ebbcf751c60cea3))
* **tool-ref:** /ref viewer pages refs, output first, intent on top ([ce53b8b](https://github.com/Elven9/pi-agent/commit/ce53b8b09a96c6a9d2e0bba1da0c944d63289b64))
* **tool-ref:** codemode scripts and structured results ([fa44a4e](https://github.com/Elven9/pi-agent/commit/fa44a4e6b3be099c0a941607bef745cee7f2c294))
* **tool-ref:** compact codemode rows with intent, handle and duration ([82b3036](https://github.com/Elven9/pi-agent/commit/82b3036c0538b65c723a2302ed49d1d97685078e))
* **tool-ref:** extension with trailers, counter and tools ([c1ebb0d](https://github.com/Elven9/pi-agent/commit/c1ebb0dc7f5c17c02687893ad4e69b30c2a5223d))
* **tool-ref:** guideline to cite tool results inline when reporting to the user ([b5ce9a1](https://github.com/Elven9/pi-agent/commit/b5ce9a18ebc58c069d826060f6dfe4c05eea5900))
* **tool-ref:** handle parsing, resolver and get/grep formatting ([6966b94](https://github.com/Elven9/pi-agent/commit/6966b94c96d785ab3ef58dc83ab9e3cd442758d5))
* **tool-ref:** load tool-ref everywhere, last ([c034f80](https://github.com/Elven9/pi-agent/commit/c034f80641d145950dcee01c063c00ae2bb0855f))
* **tool-ref:** quick summary of /ref calls with toolRef.summaryModel ([13fa821](https://github.com/Elven9/pi-agent/commit/13fa8213ac1e89e70f5e50da612506daa094ce9c))
* **tool-ref:** show /ref in a scrollable overlay panel ([4f26c70](https://github.com/Elven9/pi-agent/commit/4f26c70869fc9e52cf650bf981f2ce820a5fa037))
* **tool-ref:** syntax highlighting and markdown summaries in the /ref viewer ([76a55e4](https://github.com/Elven9/pi-agent/commit/76a55e4fffe5a4e44af4942c90a370376fd85b48))
* **wrapper:** add the wrapper: run pi in JSON mode and write report.json ([746eac1](https://github.com/Elven9/pi-agent/commit/746eac18fe651351bec0f008b2196fdb129c1e9b))
* **wrapper:** port metrics and the tool log to pi's JSON event stream ([50171e9](https://github.com/Elven9/pi-agent/commit/50171e970c369c32bfcf7820c71ab9768c16d3a7))
* **wrapper:** wire --project into the wrapper and the report ([b2e58e2](https://github.com/Elven9/pi-agent/commit/b2e58e2aa88c6e157c0f29bea35e28c6977b5537))


### Bug Fixes

* **project:** show the startup error in the TUI (print it after pi stops the TUI) ([680dbd1](https://github.com/Elven9/pi-agent/commit/680dbd1d1f2f6f3f030df3f909bdb067d8cd0c8c))
* **runner:** also report an unknown scenario on stderr ([ac9974a](https://github.com/Elven9/pi-agent/commit/ac9974ae7e1f2f4c8c64cb0d26d35f6451453b6e))
* **scenario-profile:** restore extension tools' promptGuidelines under a scenario ([40e4969](https://github.com/Elven9/pi-agent/commit/40e4969e27ac8e3a90bd0a50ab611624b079a13d))
* **tool-ref:** blank lines between details, input and output in /ref ([864427d](https://github.com/Elven9/pi-agent/commit/864427da654625fa609bcbdd84124ecb5da17b6f))
* **tool-ref:** hide the trailer when tool results are drawn ([59ac5eb](https://github.com/Elven9/pi-agent/commit/59ac5eb298cf1fdd64c185fe4b2519ec5208a80a))
* **wrapper:** give pi the .md loader hook when the wrapper runs from source ([e288a3a](https://github.com/Elven9/pi-agent/commit/e288a3a640d9ae193ed8786152b7c78fa393c57c))
