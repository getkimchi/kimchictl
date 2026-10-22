import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isKimchiProvider } from "./provider-ids.js"

/**
 * Merge (or strip) the `X-Organization-ID` header on every Kimchi-managed
 * provider entry in models.json WITHOUT touching anything else — a port of
 * the harness's `applyOrganizationHeader`
 * (kimchi-dev:src/models.ts). models.json is the harness's file; kimchictl
 * only ever adjusts this one header: set after an SSO login, stripped after
 * an API-key login (so a stale org from a previous SSO session never routes
 * key-based requests to the wrong organization).
 */

const ORGANIZATION_HEADER = "X-Organization-ID"

export function applyOrganizationHeader(modelsJsonPath: string, organizationId: string | undefined): void {
	if (!existsSync(modelsJsonPath)) return
	let config: { providers?: Record<string, { headers?: Record<string, string> }> }
	try {
		config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
	} catch {
		// A models.json that does not parse is surfaced by the harness's own
		// startup warnings; do not make the org header the thing that fails
		// kimchictl login.
		return
	}
	let changed = false
	for (const providerId of Object.keys(config.providers ?? {})) {
		if (!isKimchiProvider(providerId)) continue
		const entry = config.providers?.[providerId]
		if (!entry) continue
		const headers = { ...(entry.headers ?? {}) }
		const hasHeader = Object.hasOwn(headers, ORGANIZATION_HEADER)
		if (organizationId) {
			if (headers[ORGANIZATION_HEADER] !== organizationId) {
				headers[ORGANIZATION_HEADER] = organizationId
				entry.headers = headers
				changed = true
			}
		} else if (hasHeader) {
			// Explicit removal keeps the entry shape identical to a
			// never-SSO'd provider.
			delete headers[ORGANIZATION_HEADER]
			entry.headers = headers
			changed = true
		}
	}
	if (changed) writeFileSync(modelsJsonPath, JSON.stringify(config, null, "\t"), "utf-8")
}
