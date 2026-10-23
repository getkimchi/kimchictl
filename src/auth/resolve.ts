import { readAuthJson, readSavedApiKey, readSharedOAuthCredential, syncSharedOAuth } from "./auth-file.js"
import { readApiKeyFromConfig } from "./config-file.js"
import { isInvalidGrantError, needsRefresh, refreshCredential, type SsoCredential } from "./oauth.js"
import { resolveAuthJsonPath, resolveConfigJsonPath } from "./paths.js"

export type ApiKeySource = "environment" | "config" | "auth-json" | "auth-json-oauth"

export interface ResolvedApiKey {
	key: string
	source: ApiKeySource
}

/**
 * Credential resolution, mirroring the harness precedence
 * (kimchi-dev:src/config.ts — env key beats the saved login):
 *   1. KIMCHI_API_KEY environment variable
 *   2. config.json `apiKey` (the harness's saved key)
 *   3. auth.json `kimchi-dev` entry (api_key)
 *   4. auth.json `kimchi-dev` entry (oauth — CAST AI SSO)
 *
 * The OAuth tier is served by `resolveCredential`, which also handles the
 * just-in-time refresh; `resolveApiKey` stays for callers that only need a
 * bearer string (it includes the OAuth access token as a last resort).
 */
export function resolveApiKey(env: NodeJS.ProcessEnv = process.env): ResolvedApiKey | undefined {
	const envKey = env.KIMCHI_API_KEY?.trim()
	if (envKey) return { key: envKey, source: "environment" }

	const configPath = resolveConfigJsonPath(env)
	const configKey = readApiKeyFromConfig(configPath)
	if (configKey) return { key: configKey, source: "config" }

	const authPath = resolveAuthJsonPath(env)
	const authKey = readSavedApiKey(authPath)
	if (authKey) return { key: authKey, source: "auth-json" }

	const oauth = readSharedOAuthCredential(authPath)
	if (oauth) return { key: oauth.access, source: "auth-json-oauth" }

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

/** A resolved credential, whichever slot it came from. */
export interface ResolvedCredential {
	/** The bearer string requests send. */
	bearer: string
	/** CAST AI organization id, when the credential is org-scoped (SSO). */
	organizationId?: string
	/** The stored SSO credential, when the slot is the OAuth one. */
	sso?: SsoCredential
	source: ApiKeySource
}

/**
 * Resolve the credential for API calls, including the OAuth tier with a
 * just-in-time refresh: an SSO credential inside the five-minute pre-expiry
 * window is renewed once (rotation-safe, org fields carried over) and the
 * full auth.json fan-out rewritten before the first call. Key-based slots
 * pass through untouched.
 *
 * Throws NotLoggedInError when nothing is stored; rethrows refresh errors
 * (the caller surfaces "sign in again" on invalid_grant).
 */
export async function resolveCredential(env: NodeJS.ProcessEnv = process.env): Promise<ResolvedCredential> {
	const envKey = env.KIMCHI_API_KEY?.trim()
	if (envKey) return { bearer: envKey, source: "environment" }

	const configPath = resolveConfigJsonPath(env)
	const configKey = readApiKeyFromConfig(configPath)
	if (configKey) return { bearer: configKey, source: "config" }

	const authPath = resolveAuthJsonPath(env)
	const authKey = readSavedApiKey(authPath)
	if (authKey) return { bearer: authKey, source: "auth-json" }

	const sso = readSharedOAuthCredential(authPath)
	if (!sso) throw new NotLoggedInError()

	let credential = sso
	if (needsRefresh(credential)) {
		// Once per invocation: renew and rewrite the shared fan-out so the
		// harness (and the next kimchictl run) see the fresh token. A dead
		// refresh token surfaces as invalid_grant — keep the stored
		// credential and let the caller tell the user to sign in again.
		try {
			credential = await refreshCredential(credential, { fetch: undefined })
			const providerIds = kimchiProviderIdsFromAuth(authPath)
			await syncSharedOAuth(authPath, credential, providerIds)
		} catch (err) {
			if (isInvalidGrantError(err)) {
				throw new RefreshRequiredError(err instanceof Error ? err.message : undefined)
			}
			// Transient refresh failure (network/5xx): fall through with the
			// stored token — the API call will retry or surface its own error.
		}
	}

	return {
		bearer: credential.access,
		organizationId: credential.orgId,
		sso: credential,
		source: "auth-json-oauth",
	}
}

/** The refresh token is dead; the user must sign in again. Carries the
 * IdP's reason (e.g. Auth0's "Unknown or invalid refresh token") so
 * policy problems (short token lifetime, rotation reuse) are visible in
 * the terminal instead of a generic expiry message. */
export class RefreshRequiredError extends Error {
	constructor(detail?: string) {
		super(
			`Your CAST AI sign-in's refresh token was rejected` +
				(detail ? ` — ${detail}` : "") +
				`. Run \`kimchictl login\` to sign in again.` +
				` If this keeps happening, check the Auth0 application's refresh-token policy` +
				` (rotation off, long idle/absolute lifetime).`,
		)
		this.name = "RefreshRequiredError"
	}
}

/** Kimchi provider ids currently fanned out in auth.json (for refresh rewrites). */
function kimchiProviderIdsFromAuth(authPath: string): string[] {
	// The fan-out spans exactly the ids present as Kimchi entries; models.json
	// is the fuller source but auth.json alone is enough to preserve it.
	const raw = readAuthJson(authPath)
	return Object.keys(raw).filter(
		(id) => id === "kimchi-dev" || id.startsWith("kimchi-dev/") || id === "kimchi-experimental",
	)
}
