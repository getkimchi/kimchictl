# kimchictl

`kimchictl` is the standalone CLI for [kimchi](https://kimchi.dev) remote workspaces — create them, list them, and attach your terminal or editor over plain SSH.

- Run heavyweight agents, databases, dev servers in a remote workspace
- Connect with any SSH-capable tool: terminal, `scp`, git-over-ssh, Editor remote extensions
- Shares the `kimchi` coding agent's login — one sign-in for both tools

## Install

### Prebuilt binary (recommended)

```sh
curl -fsSL https://github.com/getkimchi/kimchictl/releases/latest/download/install.sh | sh
```

The installer ships as a release asset, so it always matches the binaries it downloads. macOS binaries are Developer ID–signed with a hardened runtime (same signing infrastructure as the kimchi harness); SHA-256 checksums ship alongside every release. Installs to `/usr/local/bin` (or `~/.local/bin`, override with `KIMCHICTL_INSTALL`), verifies checksums, and configures the SSH integration (see below). Pin a release with `VERSION=0.2.0 sh`.

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

- `~/.config/kimchi/kimchictl/ssh_config` — a `Host *.remote.kimchi.dev *.remote.us-1.kimchi.dev` block routing connections through `kimchictl ssh proxy %h` as `ProxyCommand`
- an `Include ~/.config/kimchi/kimchictl/ssh_config` block (marker-wrapped) at the **top** of your `~/.ssh/config`, so it can't be shadowed by existing `Host *` default

The ProxyCommand pins a fully-qualified command — the binary's own path, or `node <cli.js>` for JS-runtime installs — so connections never depend on `PATH`. If the executable later moves, the next `kimchictl ssh setup` detects the drift and rewrites it.

That is all workspace connectivity needs — `ssh <name>.remote.kimchi.dev` (or the region-pinned `<name>.remote.us-1.kimchi.dev`), `scp`, git-over-ssh, and editor Remote-SSH extensions just work.

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

`workspace create` prints progress, the connect commands, and finally the alias as the last stdout line — capture it with `kimchictl workspace create | tail -1`.

## Sharing auth with the kimchi agent

`kimchictl login` writes the same credential files the kimchi coding agent uses — `~/.config/kimchi/harness/auth.json` (provider `kimchi-dev`) and the `apiKey` field of `~/.config/kimchi/config.json` — so either tool can sign you in and the other is logged in. `KIMCHI_API_KEY` overrides the file-based credentials.

### CAST AI SSO login

`kimchictl login` offers **Sign in with CAST AI (SSO)** as the recommended method (run it without flags to pick from the method menu, or pass `--sso` directly; `--region us|eu` selects the tenant, defaulting to the harness's stored region): a standard OAuth 2.0 Authorization Code + PKCE browser login against the CAST AI Auth0 tenant of the region. After the browser callback, kimchictl lists your organizations and asks you to pick one (a single-organization account is selected automatically).

The resulting credential is a refreshable, organization-scoped `{ type: "oauth" }` entry — the same shape the kimchi harness writes into the shared `auth.json`. Whichever tool performs the SSO login, the other picks it up: a harness login gives kimchictl the stored organization (no re-selection), and vice versa. Expired tokens are renewed transparently; if the refresh token is revoked you are asked to sign in again.

Every platform request carries the selected organization as the `X-Organization-ID` header. The browser methods (SSO and the legacy API-key handoff) are interactive-only; use `--api-key` for CI. `KIMCHICTL_LOGIN_METHOD=sso|browser|api-key` preselects the interactive menu's method.

The SSO flow uses a fixed loopback callback at `http://localhost:8765/callback` (the redirect URI registered with the Auth0 application); only one CAST AI sign-in can run at a time per machine — across kimchictl *and* the harness.

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
| `KIMCHICTL_LOGIN_METHOD` | Preselect the interactive login method (`sso`\|`browser`\|`api-key`) |
| `KIMCHI_OAUTH_CLIENT_ID` / `KIMCHI_OAUTH_CLIENT_ID_<REGION>` | SSO client id override (per-region wins) |
| `KIMCHI_OAUTH_AUTHORIZE_URL` | SSO authorize endpoint override (dev/mock) |
| `KIMCHI_OAUTH_TOKEN_URL` | SSO token endpoint override (dev/mock) |
| `KIMCHI_ORGANIZATIONS_URL` | SSO user-organizations listing override (dev/mock) |

## Development

```sh
bun install              # or: pnpm install
bun dev -- help          # run from source
pnpm run check           # biome + typecheck + unit tests
pnpm run build           # emit dist/
```

The release pipeline compiles single-file binaries via `bun build --compile` per platform and publishes them to GitHub Releases; the npm package is a thin ESM distribution.
