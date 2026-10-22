import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { SsoCredential } from "./oauth.js"
import { isKimchiProvider } from "./provider-ids.js"

/**
 * Shared auth.json access — a port of the kimchi harness's `syncPiAuth`
 * (kimchi-dev:src/pi-auth.ts). The file format is the harness's pi auth
 * storage:
 *
 *   { "<providerId>": { "type": "api_key", "key": "…" }, … }
 *
 * written pretty-printed (2-space indent, trailing newline), mode 0600.
 * kimchictl must stay byte-compatible: the harness reads the entries this
 * writes, and vice versa.
 *
 * Locking: the harness uses proper-lockfile for the same file. kimchictl
 * writes atomically via temp-file-and-rename (POSIX atomic) instead —
 * zero transitive dependencies, which matters because this module runs
 * inside the harness's dynamically-imported package tree where CJS
 * transitive deps (graceful-fs) don't always resolve.
 */

/** Read the raw auth.json map. Returns {} when the file is absent or blank. */
export function readAuthJson(authPath: string): Record<string, unknown> {
	if (!existsSync(authPath)) return {}
	return JSON.parse(readFileSync(authPath, "utf-8") || "{}") as Record<string, unknown>
}

/** Read the saved Kimchi API key, if the shared auth.json has one. */
export function readSavedApiKey(authPath: string): string | undefined {
	const entry = readAuthJson(authPath)["kimchi-dev"]
	if (entry && typeof entry === "object" && "key" in entry && typeof entry.key === "string" && entry.key.length > 0) {
		return entry.key
	}
	return undefined
}

/**
 * Read the shared CAST AI SSO credential, if the `kimchi-dev` entry is an
 * oauth one (written by this tool or the harness — same shape). The extras
 * (region/tokenUrl/clientId/useIdToken/orgId…) are the refresh and org
 * contract; unknown extra fields are preserved as-is for forward
 * compatibility with harness-side additions.
 */
export function readSharedOAuthCredential(authPath: string): SsoCredential | undefined {
	const entry = readAuthJson(authPath)["kimchi-dev"]
	if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "oauth") return undefined
	const c = entry as Record<string, unknown>
	if (typeof c.access !== "string" || typeof c.refresh !== "string" || typeof c.expires !== "number") {
		return undefined
	}
	if (typeof c.tokenUrl !== "string" || typeof c.clientId !== "string") return undefined
	return {
		type: "oauth",
		access: c.access,
		refresh: c.refresh,
		expires: c.expires,
		region: typeof c.region === "string" ? c.region : "us",
		tokenUrl: c.tokenUrl,
		clientId: c.clientId,
		...(typeof c.audience === "string" ? { audience: c.audience } : {}),
		useIdToken: c.useIdToken !== false,
		...(typeof c.idToken === "string" ? { idToken: c.idToken } : {}),
		...(typeof c.accessToken === "string" ? { accessToken: c.accessToken } : {}),
		...(typeof c.orgId === "string" ? { orgId: c.orgId } : {}),
		...(typeof c.orgName === "string" ? { orgName: c.orgName } : {}),
	}
}

/**
 * Replace all Kimchi-managed entries in auth.json with the OAuth credential
 * fan-out: `{ ...credential }` for every provider id (deduped, "kimchi-dev"
 * always included). Same clear-then-write semantics and atomic write as
 * `syncSharedAuth`; non-Kimchi providers are preserved untouched. The
 * written shape is byte-identical to the harness's
 * `syncOAuthCredentialToKimchiProviders`, so either tool's login is usable
 * by the other.
 */
export async function syncSharedOAuth(
	authPath: string,
	credential: SsoCredential,
	providerIds: readonly string[],
): Promise<void> {
	mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 })

	const authExists = existsSync(authPath)
	const credentials = authExists ? readAuthJson(authPath) : {}
	const nextCredentials = { ...credentials }
	for (const providerId of Object.keys(nextCredentials)) {
		if (isKimchiProvider(providerId)) {
			delete nextCredentials[providerId]
		}
	}

	const ids = new Set([...providerIds.filter(isKimchiProvider), "kimchi-dev"])
	for (const providerId of ids) {
		nextCredentials[providerId] = { ...credential }
	}

	if (authExists && isDeepStrictEqual(credentials, nextCredentials)) {
		chmodSync(authPath, 0o600)
		return
	}

	const tempPath = join(dirname(authPath), `.${basename(authPath)}.tmp-${process.pid}`)
	try {
		writeFileSync(tempPath, `${JSON.stringify(nextCredentials, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
		renameSync(tempPath, authPath)
		chmodSync(authPath, 0o600)
	} catch (err) {
		rmSync(tempPath, { force: true })
		throw err
	}
}

/**
 * Replace all Kimchi-managed entries in auth.json: delete every existing
 * kimchi provider credential (`kimchi-dev`, `kimchi-dev/*`,
 * `kimchi-experimental`), then, when apiKey is non-empty, write
 * `{ type: "api_key", key }` for each id in providerIds (deduped,
 * "kimchi-dev" always included). Empty apiKey = pure clear.
 *
 * Non-Kimchi providers are preserved untouched. Mirrors the harness: no-op
 * content only re-chmods to 0600 instead of rewriting.
 */
export async function syncSharedAuth(authPath: string, apiKey: string, providerIds: readonly string[]): Promise<void> {
	mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 })

	const authExists = existsSync(authPath)
	if (!apiKey && !authExists) return

	const credentials = authExists ? readAuthJson(authPath) : {}
	const nextCredentials = { ...credentials }
	for (const providerId of Object.keys(nextCredentials)) {
		if (isKimchiProvider(providerId)) {
			delete nextCredentials[providerId]
		}
	}

	if (apiKey) {
		const ids = new Set([...providerIds.filter(isKimchiProvider), "kimchi-dev"])
		for (const providerId of ids) {
			nextCredentials[providerId] = { type: "api_key", key: apiKey }
		}
	}

	if (authExists && isDeepStrictEqual(credentials, nextCredentials)) {
		chmodSync(authPath, 0o600)
		return
	}

	// Atomic write: temp file + rename (POSIX), so the harness never sees a
	// partially-written auth.json. The temp file is cleaned up on failure.
	const tempPath = join(dirname(authPath), `.${basename(authPath)}.tmp-${process.pid}`)
	try {
		writeFileSync(tempPath, `${JSON.stringify(nextCredentials, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
		renameSync(tempPath, authPath)
		chmodSync(authPath, 0o600)
	} catch (err) {
		rmSync(tempPath, { force: true })
		throw err
	}
}

/** Remove all Kimchi credentials from auth.json (logout path). No-op when absent. */
export async function clearSharedAuth(authPath: string): Promise<void> {
	await syncSharedAuth(authPath, "", [])
}

/** Kimchi provider ids listed in an existing harness models.json ({} when absent/unreadable). */
export function kimchiProviderIdsFromModelsJson(modelsPath: string): string[] {
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(modelsPath, "utf-8"))
	} catch {
		// models.json is the harness's file; an absent or corrupt one must not
		// block kimchictl login — the provider-id list falls back to the metadata fetch.
		return []
	}
	if (!parsed || typeof parsed !== "object" || !("providers" in parsed)) return []
	const providers = (parsed as { providers: unknown }).providers
	if (!providers || typeof providers !== "object") return []
	return Object.keys(providers).filter(isKimchiProvider)
}
