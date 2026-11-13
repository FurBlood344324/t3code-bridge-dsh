# t3code-bridge-dsh: design

Goal: run every DeepSeek Harness (dsh) profile as a native T3 Code agent: normal thread agent, `delegate_task`
subagent, model picker, usage, session list/resume. One T3 provider instance per dsh profile.

## Research findings (2026-11-13, T3 Code 0.1.9, dsh 0.2.2-rc.1)

1. **T3 Code has no third-party driver plugin API.** Driver kinds are a closed built-in list in the server bundle
   (`BUILT_IN_DRIVERS`: codex, claudeAgent, cursor, grok, fx, opencode, antigravity, kiro, muse, pi, acpRegistry).
   An "extension" that registers a new driver is not possible without patching T3.
2. **But T3 has the `acpRegistry` driver with `source: "local"`.** Instance config:
   `{ source: "local", commandPath, commandArgs, authMethodId?, enabled }`. T3 spawns the command and speaks the
   Agent Client Protocol (ACP) over stdio. Any ACP agent becomes a native provider; multiple instances are allowed
   (`supportsMultipleInstances`). Instances live in `~/.t3/userdata/settings.json` under `providerInstances`.
3. **dsh already ships an ACP app:** `dsh --profile acp` (bundle `@deepseek-ai/dsh-acp-app`) serves ACP over stdio.
   Verified: `initialize` returns `agentInfo deepseek-harness-acp`, `sessionCapabilities {close, list, resume}`,
   `mcpCapabilities.http`; `session/list` returns the real sessions in `$DSH_HOME/sessions`.
4. **End to end verified:** a T3 instance `{driver:"acpRegistry", config:{source:"local", commandPath:"dsh",
   commandArgs:["--profile","acp"]}}` appeared in `orchestrator_capabilities` with discovered models and
   `reasoning_effort` options, `canRunChildTask: true`, `canRunCrossProviderChildTask: true` (so `delegate_task`
   subagents work). A real run reached DeepSeek; the provider error (`Insufficient Balance`) came back through T3
   as a failed run summary, so the error path works too.
5. **T3 handles ACP `usage_update`** notifications (server ACP adapter), so token usage can come from the stream.
   T3's offline usage scanner only reads claude/codex/grok/pi session dirs, so history from past dsh sessions is
   not shown; dsh's own counter is `~/.dsh/bot/usage.sqlite` (`calls`).
6. **A dsh profile = `package.json` `dsh.profile.bundles` + `cordis.patch.yml`.** The shipped `acp` profile is
   `[@deepseek-ai/dsh-base, @deepseek-ai/dsh-acp-app]`. Profiles `web`, `dsbot`, `headless`, `dsh-tui`,
   `open-design` each have one *app* bundle (web-app, ds-bot, headless, dsh-tui, open-design runtime) plus plugin
   bundles (dsh-beyin, dsh-bulk-read, ...) and model routes in `cordis.patch.yml`.
7. **Past dsh sessions as real chats** needs T3 native session import. T3's agent-session importer supports only
   `claudeAgent | codex | pi` file sources. ACP `session/list` + `session/resume` exist in dsh; whether T3's UI lists
   and resumes native ACP sessions is an open question (milestone 3).

## Architecture

No T3 patching. The package is a CLI that produces configuration:

    t3code-bridge-dsh doctor                 check dsh, T3 settings, ACP handshake per profile
    t3code-bridge-dsh profiles               list dsh profiles and whether an ACP variant exists
    t3code-bridge-dsh install [--profile p ...|--all] [--dry-run]
        for each dsh profile P:
          1. ensure an ACP-capable variant profile `P-acp` under $DSH_HOME/profiles:
             package.json = P's package.json with the app bundle replaced by @deepseek-ai/dsh-acp-app
             (plugin bundles, dependencies and cordis.patch.yml kept; patch.yml copied, with a header marker)
          2. add T3 provider instance `dsh-P` {driver: acpRegistry, config: {source: local, commandPath: <dsh path>,
             commandArgs: [--profile, P-acp]}, displayName: "DSH P"} to settings.json
          settings.json edits: backup first, atomic write, only touch keys owned by this tool (`dsh-*` instances
          carrying the marker), idempotent.
    t3code-bridge-dsh uninstall [--profile p|--all]
    t3code-bridge-dsh sync                   re-copy patch.yml/package.json when the source profile changed
    t3code-bridge-dsh usage [--since d]      per-profile token totals from dsh's own counters

Rules: never edit the source profile; never write outside `$DSH_HOME/profiles/*-acp` and the owned keys of
`~/.t3/userdata/settings.json`; every write has a dry-run; zero runtime dependencies (Node >= 20 builtins only).

## Milestones

- M1 (this repo, first commit): CLI skeleton, `profiles`, `doctor` (ACP probe), `install`/`uninstall` with
  dry-run, unit tests with fake `$DSH_HOME` and fake settings.json.
- M2: `usage` command, per-profile defaults (model, reasoning effort) in the instance config, `sync`.
- M3: native session visibility: test T3 against `session/list`/`resume`; if T3 does not surface them, evaluate an
  optional ACP wrapper (`t3code-bridge-dsh acp`) that adds `session/load` replay and titles from
  `session/title`.
- M4: npm publish (`t3code-bridge-dsh`, bin), CI (node test), README, then flip the repo public.

## Open questions

- Does the T3 UI list/resume native ACP sessions (`nativeSessions` readiness)? Needs a live check with a funded model.
- `deepseek-account` model route returned `Insufficient Balance`; the operator's working route is `opendesign`/pi.
  Which model route should each ACP profile default to?
- dsbot/web profile app bundles may register capabilities (Telegram bot, web UI) that do not belong in an ACP
  variant; the replacement list of app bundles is configurable, default
  `dsh-web-app, dsh-headless, dsh-sdk-app, dsh-sdk-minimal, ds-bot, @deepseek-harness-tui/dsh-tui`.
