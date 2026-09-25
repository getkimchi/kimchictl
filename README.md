# kimchictl

`kimchictl` is the standalone CLI for [kimchi](https://kimchi.dev) remote workspaces — create them, list them, and attach your terminal or editor over plain SSH.

- Run heavyweight agents, databases, dev servers in a remote workspace
- Connect with any SSH-capable tool: terminal, `scp`, git-over-ssh, Editor remote extensions
- Shares the `kimchi` coding agent's login — one sign-in for both tools

## Install

### Prebuilt binary (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/getkimchi/kimchictl/main/scripts/install.sh | sh
```

Installs to `/usr/local/bin` (or `~/.local/bin`, override with `KIMCHICTL_INSTALL`), verifies checksums, and configures the SSH integration (see below). Pin a release with `VERSION=0.2.0 sh`.

### Homebrew (macOS/Linux)

```sh
brew install getkimchi/tap/kimchictl
```

post-install, the formula offers the same SSH integration step.

### npm (consumes the JS build, mainly for the kimchi harness)

```sh
npm install -g @kimchi-dev/kimchictl
```

## Getting started

```sh
kimchictl login                      # browser sign-in (shared with the kimchi agent)
kimchictl workspace create --desc "blog refactor"
kimchictl ssh pensive-brainy-kimchi-c711c6-56d6      # or plain: ssh <name>.remote.kimchi.dev
```

`workspace create` defaults to a random base template (Rust, Python, Go, JS/TS). Pass `--template <name>` once named templates ship; the CLI tells you when the API starts accepting them.

## SSH integration

At install time (and on first `kimchictl ssh`), kimchictl writes:

- `~/.kimchictl/ssh_config` — a `Host *.remote.kimchi.dev` block routing connections through `kimchictl ssh proxy %h` as `ProxyCommand`
- an `Include ~/.kimchictl/ssh_config` block (marker-wrapped) at the **top** of your `~/.ssh/config`, so it can't be shadowed by existing `Host *` default

That is all workspace connectivity needs — `ssh <name>.remote.kimchi.dev`, `scp`, git-over-ssh, and editor Remote-SSH extensions just work.

- Remove: `kimchictl ssh setup --uninstall`
- Opt out of auto-setup: `export KIMCHICTL_NO_SSH_SETUP=1`
- The setup is **automatic with notice**, not interactive — it never prompts.

## Commands

```
kimchictl login [--api-key <key>]     Sign in via browser or a kimi API key
kimchictl logout [--all]              Remove kimchictl credentials (keeps kimchi agent auth by default)
kimchictl whoami                      Show the logged-in account and auth source

kimchictl workspace create [--desc "..."] [--no-wait]
kimchictl workspace list [--output table|json]      (alias: ws)
kimchictl workspace get <name>
kimchictl workspace delete <name> [--force]

kimchictl ssh <name> [command...]     Connect (resumes hibernated workspaces)
kimchictl ssh setup [--uninstall]     Manage the native SSH integration

kimchictl update                      Self-update binary installs (brew/npm tell you their path)
kimchictl completion <bash|zsh|fish>  Print shell completions
kimchictl version                     Print the version
```

Suspend/resume exposed by the API today: **none**. `workspace suspend` / `workspace resume` land when the endpoints exist.

## Sharing auth with the kimchi agent

`kimchictl login` writes the shared credential store at `~/.config/kimchi-coding-agent/` (`auth.json` + `config.json`) in the exact format the kimchi coding agent uses, so either tool can sign you in and the other is logged in. `KIMCHI_API_KEY` overrides the file-based credentials.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `KIMCHI_API_KEY` | API key override (highest precedence) |
| `KIMCHI_REMOTE_ENDPOINT` | API endpoint override (default `https://app.kimchi.dev/api`) |
| `KIMCHI_WEB_APP_URL` | Web app URL override for browser login |
| `KIMCHI_CODING_AGENT_DIR` | Override the shared credential directory |
| `KIMCHICTL_NO_SSH_SETUP` | Skip all automatic SSH integration |
| `KIMCHICTL_SSH_DOMAIN` | Override the workspace wildcard domain |
| `KIMCHICTL_NO_UPDATE_CHECK` | Disable the daily background update check |

## Development

```sh
bun install              # or: pnpm install
bun dev -- help          # run from source
pnpm run check           # biome + typecheck + unit tests
pnpm run build           # emit dist/
```

The release pipeline compiles single-file binaries via `bun build --compile` per platform and publishes them to GitHub Releases; the npm package is a thin ESM distribution.
