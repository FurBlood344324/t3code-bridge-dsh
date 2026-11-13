# t3code-bridge-dsh

Run every [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) profile as a native
[T3 Code](https://t3.codes) agent: thread agent, `delegate_task` subagent, model picker, usage. One T3 provider
instance per dsh profile, built on T3's `acpRegistry` (local command) driver and dsh's ACP app.

Status: modules A–D implemented; `doctor` is the gate before you trust an install. See
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
key. Only the default route's key is required to be present.

Requires Node ≥20 and `dsh` on PATH (`node bin/t3code-bridge-dsh.js` works the same way if you would rather
keep it local).
