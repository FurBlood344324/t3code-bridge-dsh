# t3code-bridge-dsh

Run every [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) profile as a native
[T3 Code](https://t3.codes) agent: thread agent, `delegate_task` subagent, model picker, usage. One T3 provider
instance per dsh profile, built on T3's `acpRegistry` (local command) driver and dsh's ACP app.

Status: design stage. See [docs/DESIGN.md](docs/DESIGN.md).
