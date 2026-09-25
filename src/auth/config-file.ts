import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Minimal config.json access — the harness's other credential slot.
 *
 * The harness browser login writes the API key to BOTH auth.json and
 * config.json (`writeApiKey` in kimchi-dev:src/config.ts), and its startup
 * sync repairs auth.json from config.json. kimchictl mirrors that so a
 * kimchictl-first login activates the harness without a second login, and a
 * `kimchictl logout` doesn't leave a live key behind in config.json.
 *
 * Only the `apiKey` field is ever touched; all other fields are preserved.
 */

function readConfigRaw(configPath: string): Record<string, unknown> {
	if (!existsSync(configPath)) return {}
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8") || "{}")
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
	} catch {
		// A corrupt config.json must not wedge kimchictl; leave the harness to re-write it.
		return {}
	}
}

export function readApiKeyFromConfig(configPath: string): string | undefined {
	const raw = readConfigRaw(configPath)
	// The harness accepts camelCase and snake_case historical spellings.
	for (const field of ["apiKey", "api_key"] as const) {
		const value = raw[field]
		if (typeof value === "string" && value.length > 0) return value
	}
	return undefined
}

/** Set the apiKey field (pass undefined to remove it). Preserves all other fields. */
export function writeApiKeyToConfig(configPath: string, apiKey: string | undefined): void {
	const raw = readConfigRaw(configPath)
	if (apiKey === undefined) {
		if (raw.apiKey === undefined) return
		// undefined-assignment instead of delete: the file is immediately
		// JSON.stringify'd, which drops undefined properties the same way.
		raw.apiKey = undefined
	} else {
		raw.apiKey = apiKey
	}
	mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
	writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
}
