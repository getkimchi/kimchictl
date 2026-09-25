# kimchictl

> [!WARNING]
> **Experimental — not stable.** Early work. Commands and behavior will
> change without notice. Do not depend on it yet.

Command-line tool for **kimchi remote workspaces** — create sandboxes, list
them, delete them, and connect over SSH. `ssh`/`scp`/IDE remote connections
work out of the box: SSH integration is set up automatically on install.

Shares your login with the [kimchi](https://github.com/getkimchi/kimchi)
coding harness: `kimchictl login` and `kimchi login` are the same login.

## Install

Pre-built binaries (macOS, Linux, Windows) via the install script:

```sh
curl -sSL https://github.com/getkimchi/kimchictl/releases/latest -L | bash
```

Or Homebrew:

```sh
brew install getkimchi/tap/kimchictl
```

## Usage

| Command | Description |
|---|---|
| `kimchictl login` | Authenticate via browser (shared with the kimchi harness) |
| `kimchictl logout` | Sign out everywhere (also signs out the harness) |
| `kimchictl whoami` | Show the authenticated user |
| `kimchictl workspace create [--desc D] [--template NAME]` | Create a workspace (server generates the alias) |
| `kimchictl workspace list` | List workspaces (`--output table\|json`) |
| `kimchictl workspace get <name>` | Show workspace details |
| `kimchictl workspace delete <name>` | Delete a workspace |
| `kimchictl ssh <name>` | Connect (auto-configures SSH on first use, resumes hibernated workspaces) |
| `kimchictl ssh setup [--uninstall]` | Manage the native SSH integration (`~/.kimchictl/ssh_config` + `~/.ssh/config` Include) |
| `kimchictl update` | Update to the latest release |
| `kimchictl version` | Print the version |

Environment overrides:

| Variable | Description |
|---|---|
| `KIMCHI_API_KEY` | API key (highest precedence, overrides the saved login) |
| `KIMCHI_REMOTE_ENDPOINT` | Override the control-plane endpoint (default `https://app.kimchi.dev/api`) |
| `KIMCHICTL_NO_SSH_SETUP` | Skip automatic SSH integration setup |

## Development

```sh
pnpm install        # install dependencies
pnpm dev -- version # run the CLI from source (needs Bun)
pnpm run check      # lint + typecheck + test
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
