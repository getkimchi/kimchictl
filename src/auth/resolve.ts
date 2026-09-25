import { readSavedApiKey } from "./auth-file.js"
import { readApiKeyFromConfig } from "./config-file.js"
import { resolveAuthJsonPath, resolveConfigJsonPath } from "./paths.js"

export type ApiKeySource = "environment" | "config" | "auth-json"

export interface ResolvedApiKey {
	key: string
	source: ApiKeySource
}

/**
 * Credential resolution, mirroring the harness precedence
 * (kimchi-dev:src/config.ts — env key beats the saved login):
 *   1. KIMCHI_API_KEY environment variable
 *   2. config.json `apiKey` (the harness's saved key)
 *   3. auth.json `kimchi-dev` entry
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): ResolvedApiKey | undefined {
	const envKey = env.KIMCHI_API_KEY?.trim()
	if (envKey) return { key: envKey, source: "environment" }

	const configKey = readApiKeyFromConfig(resolveConfigJsonPath(env))
	if (configKey) return { key: configKey, source: "config" }

	const authKey = readSavedApiKey(resolveAuthJsonPath(env))
	if (authKey) return { key: authKey, source: "auth-json" }

	return undefined
}

/** Standard error for commands that need a credential that isn't there. */
export function requireApiKey(env: NodeJS.ProcessEnv = process.env): ResolvedApiKey {
	const resolved = resolveApiKey(env)
	if (!resolved) {
		throw new NotLoggedInError()
	}
	return resolved
}

export class NotLoggedInError extends Error {
	constructor() {
		super("Not logged in. Run `kimchictl login` first (or set KIMCHI_API_KEY).")
		this.name = "NotLoggedInError"
	}
}
