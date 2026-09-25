import { clearSharedAuth, readSavedApiKey } from "../auth/auth-file.js"
import { readApiKeyFromConfig, writeApiKeyToConfig } from "../auth/config-file.js"
import { resolveAuthJsonPath, resolveConfigJsonPath } from "../auth/paths.js"
import { parseFlags } from "./flags.js"
import { confirm, isInteractive } from "./prompt.js"

export interface LogoutDeps {
	/** Confirmation override (tests). */
	confirm?: () => Promise<boolean>
	env?: NodeJS.ProcessEnv
	/** Override TTY interactivity detection (tests). */
	interactive?: boolean
}

/**
 * `kimchictl logout` — remove the shared Kimchi credential from BOTH
 * auth.json and config.json. This signs out the kimchi coding harness too
 * (the credential is shared by design), which the user must acknowledge.
 */
export async function runLogout(args: string[], deps: LogoutDeps = {}): Promise<number> {
	const { values } = parseFlags("logout", args, {
		force: { type: "boolean", short: "f" },
	})
	const env = deps.env ?? process.env

	const authPath = resolveAuthJsonPath(env)
	const configPath = resolveConfigJsonPath(env)

	const hasCredential = readSavedApiKey(authPath) !== undefined || readApiKeyFromConfig(configPath) !== undefined
	if (!hasCredential) {
		console.log("Not logged in.")
		return 0
	}

	if (!values.force) {
		console.error("This also signs out the kimchi coding harness (the login is shared).")
		const interactive = deps.interactive ?? isInteractive()
		const ok = await (deps.confirm ? deps.confirm() : interactive ? confirm("Log out everywhere? [y/N] ") : false)
		if (!ok) {
			if (!deps.confirm && !interactive) {
				console.error("kimchictl logout: not interactive — re-run with --force to confirm")
				return 1
			}
			console.log("Aborted.")
			return 0
		}
	}

	await clearSharedAuth(authPath)
	writeApiKeyToConfig(configPath, undefined)
	console.log("✓ Logged out of Kimchi (kimchictl and the kimchi harness).")
	return 0
}
