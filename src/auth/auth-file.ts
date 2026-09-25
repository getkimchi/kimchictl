import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { lock } from "proper-lockfile"
import { isKimchiProvider } from "./provider-ids.js"

/**
 * Shared auth.json access — a port of the kimchi harness's `syncPiAuth`
 * (kimchi-dev:src/pi-auth.ts). The file format is the harness's pi auth
 * storage:
 *
 *   { "<providerId>": { "type": "api_key", "key": "…" }, … }
 *
 * written pretty-printed (2-space indent, trailing newline), mode 0600, under
 * a proper-lockfile lock. kimchictl must stay byte-compatible: the harness
 * reads the entries this writes, and vice versa.
 *
 * Difference vs the harness port: the harness derives provider ids from
 * models.json and throws when it is missing; kimchictl takes the ids as a
 * parameter (the login command derives them from models.json when present and
 * from the models metadata API otherwise) so it can run on machines that
 * have never installed the harness.
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
	const release = await lock(authPath, { realpath: false, retries: 10 })
	try {
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

		writeFileSync(authPath, `${JSON.stringify(nextCredentials, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
		chmodSync(authPath, 0o600)
	} finally {
		await release()
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
