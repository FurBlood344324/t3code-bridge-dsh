# t3code-bridge-dsh

Run every DeepSeek Harness (`dsh`) profile as a native
T3 Code agent: thread agent, `delegate_task` subagent, model picker, usage. One T3 provider
instance per dsh profile, built on T3's `acpRegistry` (local command) driver and dsh's ACP app.

Unofficial: not affiliated with T3 Code or the dsh authors. Tested against T3 Code 0.1.9 and dsh 0.2.2-rc.1.
`doctor` is the gate before you trust an install. How it works and what T3 can and cannot do with dsh sessions:
[docs/DESIGN.md](docs/DESIGN.md).

## Usage

```sh
t3code-bridge-dsh profiles                    # what dsh has, which variants/instances exist
t3code-bridge-dsh doctor                      # PASS/FAIL: dsh, keys, variants, instances, live ACP handshake
t3code-bridge-dsh install --profile web       # one profile; repeat --profile for more, or --all
t3code-bridge-dsh install --all --dry-run     # say what would happen, write nothing
t3code-bridge-dsh sync                        # refresh installed variants from their source profiles
t3code-bridge-dsh uninstall --profile web     # remove that variant and its T3 instance only
t3code-bridge-dsh routes --write              # model routes overlay (prints it without --write)
t3code-bridge-dsh usage --since 2026-11-01    # token totals from dsh's own counter (--by day, --json)
```

`install` does three things per selected dsh profile: writes `<DSH_HOME>/profiles/<name>-acp` (a copy
of the source profile with the ACP app bundle swapped in, marked with `.t3code-bridge-dsh`), writes the
model-route overlay, and adds one T3 provider instance that runs `bin/t3code-bridge-dsh.js launch <name>`. That
launcher resolves the API keys and hands the ACP stream to `dsh --profile <name>-acp`.

Nothing is written unless one of those commands runs, and only inside `$DSH_HOME`, `$T3CODE_HOME` and
`$XDG_CONFIG_HOME`. Any directory or instance this tool did not create is left alone (and reported as a
conflict), `--dry-run` writes nothing, and every settings write keeps a timestamped backup next to
`settings.json`.

Keys are read per request from the process env, then `<DSH_HOME>/.env`, then pi's `auth.json`, then
opencode's `auth.json` — first hit wins, so a rotated key needs no reinstall. Values reach only the child
process environment; `profiles`, `doctor` and `launch --verbose` print names, sources and lengths, never a
key. Only the default route's key is required to be present. The launcher puts the three route keys
(`OPEN_DESIGN_API_KEY`, `COMMAND_CODE_API_KEY`, `OPENCODE_GO_API_KEY`) in the environment of the `dsh`
process, so everything dsh runs for the agent (shell tools, plugins) inherits them: treat a profile's agent
as trusted with those keys.

`usage` reads `<DSH_HOME>/bot/usage.sqlite` (read-only). T3 itself shows no token usage for dsh runs, and
dsh's counter has no profile column, so totals are grouped by provider/model/kind or by day, not per profile.
`usage` needs Node ≥22.5 (`node:sqlite`); everything else runs on Node ≥20.

Requires Node ≥20 and `dsh` on PATH (`node bin/t3code-bridge-dsh.js` works the same way if you would rather
keep it local).
