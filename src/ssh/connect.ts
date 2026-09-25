import { spawnSync } from "node:child_process"
import type { ApiOptions } from "../api/types.js"
import { waitForWorkspaceActive } from "../api/wait.js"
import { getWorkspace } from "../api/workspaces.js"
import { requireApiKey } from "../auth/resolve.js"
import {
	isSshIntegrationConfigured,
	isSshSetupDisabled,
	resolveSshDomain,
	resolveSshPaths,
	setupSshIntegration,
} from "./config.js"
import { resumeForConnect } from "./tunnel.js"

/** Post-resume wait budget for a hibernated workspace to reach ACTIVE. */
const RESUME_WAIT_TIMEOUT_MS = 90_000

/**
 * Validate that native SSH integration is configured; set it up automatically
 * when missing (the "setup on use" half of the setup-on-install decision).
 * Returns false when auto-setup is disabled via KIMCHICTL_NO_SSH_SETUP.
 */
export async function ensureSshIntegration(options: {
	env?: NodeJS.ProcessEnv
	domain?: string
	/** Injection seams for tests. */
	setup?: typeof setupSshIntegration
	isConfigured?: typeof isSshIntegrationConfigured
}): Promise<boolean> {
	const env = options.env ?? process.env
	if (isSshSetupDisabled(env)) return false

	const paths = resolveSshPaths(env)
	const domain = resolveSshDomain(options.domain, env)
	const isConfigured = options.isConfigured ?? isSshIntegrationConfigured
	if (await isConfigured(paths, domain)) return true

	const setup = options.setup ?? setupSshIntegration
	const { notes } = await setup({ paths, domain })
	console.error("✓ SSH integration configured")
	for (const note of notes) console.error(`  ${note}`)
	console.error("  undo: kimchictl ssh setup --uninstall")
	return true
}

export interface SshConnectOptions extends ApiOptions {
	env?: NodeJS.ProcessEnv
	/** Exec seam (tests): run system ssh, return its exit status. */
	exec?: (args: string[]) => number
	sleep?: (ms: number) => Promise<void>
}

function defaultExec(args: string[]): number {
	return spawnSync(args[0] ?? "ssh", args.slice(1), { stdio: "inherit", shell: false }).status ?? 1
}

/**
 * Connect to a workspace with system ssh: ensure integration → resume a
 * hibernated workspace (and wait for it) → exec `ssh <alias>.<domain>` with
 * inherited stdio. Extra args are passed to ssh as the remote command.
 */
export async function connectToWorkspace(
	name: string,
	remoteCommand: string[],
	options: SshConnectOptions = {},
): Promise<number> {
	const env = options.env ?? process.env
	await ensureSshIntegration({ env })

	const { key } = requireApiKey(env)

	let workspace = await getWorkspace(key, name, options)
	if (workspace.status === "suspended" || workspace.status === "initializing") {
		if (workspace.status === "suspended") {
			await resumeForConnect(key, name, options)
		}
		process.stderr.write("  resuming…")
		workspace = await waitForWorkspaceActive(key, name, {
			...options,
			timeoutMs: RESUME_WAIT_TIMEOUT_MS,
			sleep: options.sleep,
			onTick: (elapsedSeconds) => process.stderr.write(`\r  resuming… ${elapsedSeconds}s`),
		})
		process.stderr.write("\n")
		if (workspace.status !== "active") {
			process.stderr.write(
				`  ⚠ workspace is ${workspace.status} — connecting anyway; ` +
					`if it fails, retry in a minute or check: kimchictl workspace get ${name}\n`,
			)
		}
	}

	const domain = resolveSshDomain(undefined, env)
	const host = `${name}.${domain}`
	return (options.exec ?? defaultExec)(["ssh", host, ...remoteCommand])
}
