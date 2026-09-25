import { existsSync } from "node:fs"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

/**
 * Native SSH integration (TS port of kap:internal/ssh/setup.go).
 *
 * Layout:
 *   ~/.config/kimchi/kimchictl/ssh_config   — `Host *.<domain>` wildcard routing
 *                                             through `kimchictl ssh proxy %h` as ProxyCommand
 *   ~/.config/kimchi/kimchictl/known_hosts  — dedicated known_hosts for workspace hosts
 *   ~/.ssh/config                           — gets a marker-wrapped `Include` block
 *
 * Behavior per the product decision "setup happens on install": writes are
 * automatic (no y/N prompt) with a clear notice; `--uninstall` reverts.
 */

export const SSH_INCLUDE_BEGIN = "# >>> kimchictl managed include >>>"
export const SSH_INCLUDE_END = "# <<< kimchictl managed include <<<"

export interface SshPaths {
	/** ~/.config/kimchi/kimchictl root (also used for the update-check cache). */
	home: string
	sshConfig: string
	knownHosts: string
	userSshConfig: string
}

export function resolveSshPaths(env: NodeJS.ProcessEnv = process.env): SshPaths {
	// Lives with the rest of the kimchi config tree (harness/, desktop/, memory/…).
	const home = env.KIMCHICTL_HOME ?? join(env.HOME ?? homedir(), ".config", "kimchi", "kimchictl")
	const userSshConfig = join(env.HOME ?? homedir(), ".ssh", "config")
	return {
		home,
		sshConfig: join(home, "ssh_config"),
		knownHosts: join(home, "known_hosts"),
		userSshConfig,
	}
}

/**
 * The wildcard domain workspaces are reached at. Default remote.kimchi.dev;
 * derived from the API endpoint host for dev environments
 * (app.X → remote.X), overridable via flag/env for exotic setups.
 */
export function resolveSshDomain(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
	if (explicit) return explicit
	if (env.KIMCHICTL_SSH_DOMAIN) return env.KIMCHICTL_SSH_DOMAIN
	const endpoint = env.KIMCHI_REMOTE_ENDPOINT
	if (endpoint) {
		try {
			const host = new URL(endpoint).hostname
			const stripped = host.startsWith("app.") ? host.slice("app.".length) : host
			return `remote.${stripped}`
		} catch {
			// Fall through to the production default below.
		}
	}
	return "remote.kimchi.dev"
}

/** Shell-quote a single ProxyCommand token when it contains whitespace. */
function shellQuote(token: string): string {
	return /\s|"|'/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token
}

/**
 * The ProxyCommand must not rely on ssh's PATH lookup — point it at a
 * fully-qualified command:
 *   - compiled binary: its own absolute path
 *   - node/bun runtime: the runtime plus the ABSOLUTE entry script
 *     (e.g. `/usr/bin/node /…/dist/cli.js`), so the config works from any cwd
 * Bare `kimchictl` remains only as a last resort when no entry can be named.
 */
export function resolveProxyCommandTarget(execPath: string = process.execPath, entryScript?: string): string {
	const base = execPath.split("/").pop() ?? ""
	if (base === "kimchictl" || base.startsWith("kimchictl-")) {
		return shellQuote(execPath)
	}
	const entry = entryScript ?? process.argv[1]
	if (entry) {
		return `${shellQuote(execPath)} ${shellQuote(resolve(entry))}`
	}
	return "kimchictl"
}

export function sshConfigContent(domain: string, knownHostsPath: string, proxyTarget: string): string {
	return (
		`Host *.${domain}\n` +
		`    ProxyCommand ${proxyTarget} ssh proxy %h\n` +
		`    UserKnownHostsFile ${knownHostsPath}\n` +
		`    StrictHostKeyChecking accept-new\n` +
		`    User developer\n`
	)
}

export interface SetupResult {
	notes: string[]
}

async function writePrivateFile(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	await writeFile(path, content, { mode: 0o600 })
	await chmod(path, 0o600)
}

function managedBlock(includePath: string): string {
	return `${SSH_INCLUDE_BEGIN}\nInclude ${includePath}\n${SSH_INCLUDE_END}`
}

/** Extract an existing managed include block (any path), or undefined. */
function extractManagedBlock(content: string): string | undefined {
	const start = content.indexOf(SSH_INCLUDE_BEGIN)
	if (start === -1) return undefined
	const endRel = content.slice(start).indexOf(SSH_INCLUDE_END)
	if (endRel === -1) return undefined
	return content.slice(start, start + endRel + SSH_INCLUDE_END.length + 1)
}

/**
 * Write the kimchictl ssh_config and ensure ~/.ssh/config includes it.
 * Idempotent; a stale managed block (different include path) is replaced in
 * place. Returns human-readable notes of everything that changed.
 */
export async function setupSshIntegration(options: {
	paths: SshPaths
	domain: string
	proxyTarget?: string
	/** Detect and warn about a kap-managed block (same wildcard domain conflict). */
	warnKapConflict?: (note: string) => void
}): Promise<SetupResult> {
	const { paths, domain } = options
	const notes: string[] = []

	const content = sshConfigContent(domain, paths.knownHosts, options.proxyTarget ?? resolveProxyCommandTarget())
	const previous = existsSync(paths.sshConfig) ? await readFile(paths.sshConfig, "utf-8") : undefined
	if (previous !== content) {
		await writePrivateFile(paths.sshConfig, content)
		notes.push(`wrote ${paths.sshConfig} (Host *.${domain})`)
	}

	let userConfig = ""
	try {
		userConfig = await readFile(paths.userSshConfig, "utf-8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
	}

	if (userConfig.includes("# >>> kap managed include >>>")) {
		notes.push(
			"⚠ found a kap-managed Include block in ~/.ssh/config — both wildcard configs match " +
				"this domain; the first Include wins. Remove one if connections route to the wrong proxy.",
		)
	}

	const block = managedBlock(paths.sshConfig)
	const existing = extractManagedBlock(userConfig)
	if (existing === undefined) {
		// First match in ssh config wins for most options: the Include must come first.
		const next = userConfig.length > 0 ? `${block}\n\n${userConfig}` : `${block}\n`
		await writePrivateFile(paths.userSshConfig, next)
		notes.push(`added Include block to ${paths.userSshConfig}`)
	} else if (existing !== block && existing !== `${block}\n`) {
		// Stale block (e.g. config dir moved) — replace in place.
		const next = userConfig.replace(existing, `${block}\n`)
		await writePrivateFile(paths.userSshConfig, next)
		notes.push(`updated stale Include block in ${paths.userSshConfig}`)
	}

	return { notes }
}

/** Remove the Include block and the generated ssh_config. Returns notes. */
export async function uninstallSshIntegration(options: { paths: SshPaths }): Promise<SetupResult> {
	const { paths } = options
	const notes: string[] = []

	let userConfig = ""
	try {
		userConfig = await readFile(paths.userSshConfig, "utf-8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
	}

	const existing = extractManagedBlock(userConfig)
	if (existing !== undefined) {
		let next = userConfig.replace(existing, "")
		// Tidy the blank line we added after the block when nothing precedes it.
		next = next.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n")
		await writePrivateFile(paths.userSshConfig, next)
		notes.push(`removed Include block from ${paths.userSshConfig}`)
	}

	if (existsSync(paths.sshConfig)) {
		// Remove rather than truncate: keep the dir (it also holds known_hosts/cache).
		await rm(paths.sshConfig, { force: true })
		notes.push(`removed ${paths.sshConfig}`)
	}

	return { notes }
}

/**
 * True when the generated ssh_config exists AND the user config includes it.
 * Used by `ssh <name>` / `login` to auto-setup when missing.
 */
export async function isSshIntegrationConfigured(
	paths: SshPaths,
	domain: string,
	proxyTarget?: string,
): Promise<boolean> {
	if (!existsSync(paths.sshConfig)) return false
	try {
		const userConfig = await readFile(paths.userSshConfig, "utf-8")
		const expected = managedBlock(paths.sshConfig)
		const existing = extractManagedBlock(userConfig)
		if (existing !== expected && existing !== `${expected}\n`) return false
		const generated = await readFile(paths.sshConfig, "utf-8")
		// Both domain drift (endpoint override changed) and proxy-target drift
		// (the executable moved since setup) must re-trigger setup: compare the
		// full expected content.
		return generated === sshConfigContent(domain, paths.knownHosts, proxyTarget ?? resolveProxyCommandTarget())
	} catch {
		return false
	}
}

/** Disabled-marker env var honored by every auto-setup caller. */
export function isSshSetupDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.KIMCHICTL_NO_SSH_SETUP
	return value !== undefined && value !== "" && value !== "0" && value !== "false"
}
