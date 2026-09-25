import { verifyApiKey } from "../api/keys.js"
import { requireApiKey } from "../auth/resolve.js"
import { bridgeStdioToWebSocket } from "../ssh/bridge.js"
import {
	isSshIntegrationConfigured,
	resolveSshDomain,
	resolveSshPaths,
	setupSshIntegration,
	uninstallSshIntegration,
} from "../ssh/config.js"
import { connectToWorkspace } from "../ssh/connect.js"
import { resolveTunnel } from "../ssh/tunnel.js"
import { parseFlags, UsageError } from "./flags.js"

export interface SshDeps {
	fetch?: typeof globalThis.fetch
	env?: NodeJS.ProcessEnv
	interactive?: boolean
	/** Exec seam (tests). */
	exec?: (args: string[]) => number
	sleep?: (ms: number) => Promise<void>
}

const GROUP_USAGE = `Usage:
  kimchictl ssh <name> [command...]   Connect to a workspace (auto-configures SSH on first use)
  kimchictl ssh setup [--uninstall]   Manage the native SSH integration`

/**
 * `kimchictl ssh …` — connect, or manage the SSH integration. The hidden
 * `proxy` subcommand is the ProxyCommand target in the generated ssh_config
 * and is deliberately absent from help (internal plumbing, not user-facing).
 */
export async function runSsh(args: string[], deps: SshDeps = {}): Promise<number> {
	const [head, ...rest] = args
	switch (head) {
		case "setup":
			return runSetup(rest, deps)
		case "proxy":
			return runProxy(rest, deps)
		case "help":
		case "--help":
		case "-h":
			console.log(GROUP_USAGE)
			return 0
		case undefined:
			console.error(GROUP_USAGE)
			return 2
		default:
			return connectToWorkspace(head, rest, deps)
	}
}

// ---------------------------------------------------------------- setup

async function runSetup(args: string[], deps: SshDeps): Promise<number> {
	const { values, positionals } = parseFlags("ssh setup", args, {
		uninstall: { type: "boolean" },
		domain: { type: "string" },
	})
	if (positionals.length > 0) {
		throw new UsageError("kimchictl ssh setup: unexpected positional argument")
	}
	const env = deps.env ?? process.env
	const paths = resolveSshPaths(env)

	if (values.uninstall) {
		const { notes } = await uninstallSshIntegration({ paths })
		if (notes.length === 0) {
			console.log("Nothing to remove — SSH integration was not configured.")
			return 0
		}
		console.log("✓ SSH integration removed")
		for (const note of notes) console.log(`  ${note}`)
		return 0
	}

	const domain = resolveSshDomain(typeof values.domain === "string" && values.domain ? values.domain : undefined, env)
	if (await isSshIntegrationConfigured(paths, domain)) {
		console.log(`SSH integration already configured for *.${domain} (undo: kimchictl ssh setup --uninstall)`)
		return 0
	}

	const { notes } = await setupSshIntegration({ paths, domain })
	console.log("✓ SSH integration configured")
	for (const note of notes) console.log(`  ${note}`)
	console.log("") // blank line before the usage hint
	console.log(`You can now run: ssh <workspace-name>.${domain}   (scp, VS Code Remote-SSH, …)`)
	return 0
}

// ---------------------------------------------------------------- proxy (hidden)

async function runProxy(args: string[], deps: SshDeps): Promise<number> {
	const { values, positionals } = parseFlags("ssh proxy", args, {
		port: { type: "string", default: "443" },
	})
	const host = positionals[0]
	if (!host || positionals.length > 1) {
		throw new UsageError("kimchictl ssh proxy: expected one host")
	}
	const port = Number(values.port)
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new UsageError("kimchictl ssh proxy: --port must be an integer 1-65535")
	}

	const env = deps.env ?? process.env
	const { key } = requireApiKey(env)
	await verifyApiKey(key, { fetch: deps.fetch })
	const creds = await resolveTunnel(key, host, { port, fetch: deps.fetch })
	await bridgeStdioToWebSocket({ wsUrl: creds.wsUrl, token: creds.token })
	return 0
}
