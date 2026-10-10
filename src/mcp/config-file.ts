import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

/**
 * Minimal ~/.config/mcp/mcp.json access — the `cast-mcp` server entry.
 *
 * `kimchictl login` seeds an http MCP server entry carrying the API key as a
 * Bearer token, next to the shared harness credentials (auth.json +
 * config.json). `kimchictl logout` removes the entry again so no live key is
 * left behind (mirroring writeApiKeyToConfig in src/auth/config-file.ts).
 *
 * Only the `mcpServers["cast-mcp"]` entry is ever touched; all other servers
 * and fields are preserved. A corrupt mcp.json is treated as empty — login
 * rewrites our entry, and removal leaves the file untouched.
 */

const SERVER_NAME = "cast-mcp"
const SERVER_URL = "https://api.cast.ai/mcp"

/** Fixed path (no env override), matching the shared config.json convention. */
export function resolveMcpJsonPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.HOME ?? homedir(), ".config", "mcp", "mcp.json")
}

function readMcpRaw(configPath: string): Record<string, unknown> {
	if (!existsSync(configPath)) return {}
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8") || "{}")
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
	} catch {
		// A corrupt mcp.json must not wedge kimchictl.
		return {}
	}
}

function readServers(raw: Record<string, unknown>): Record<string, unknown> {
	const servers = raw.mcpServers
	return servers && typeof servers === "object" && !Array.isArray(servers) ? (servers as Record<string, unknown>) : {}
}

/** The Bearer token on the cast-mcp entry, if present and well-formed. */
export function readCastMcpApiKey(configPath: string): string | undefined {
	const entry = readServers(readMcpRaw(configPath))[SERVER_NAME]
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined
	const headers = (entry as Record<string, unknown>).headers
	if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined
	const auth = (headers as Record<string, unknown>).Authorization
	if (typeof auth !== "string") return undefined
	return /^Bearer\s+(.+)$/.exec(auth)?.[1]
}

/** Set the cast-mcp entry (pass undefined to remove it). Preserves all other servers and fields. */
export function writeCastMcpServer(configPath: string, apiKey: string | undefined): void {
	const raw = readMcpRaw(configPath)
	const servers = readServers(raw)
	if (apiKey === undefined) {
		if (servers[SERVER_NAME] === undefined) return
		// undefined-assignment instead of delete: the file is immediately
		// JSON.stringify'd, which drops undefined properties the same way.
		servers[SERVER_NAME] = undefined
	} else {
		servers[SERVER_NAME] = {
			type: "http",
			url: SERVER_URL,
			headers: { Authorization: `Bearer ${apiKey}` },
		}
	}
	raw.mcpServers = servers
	mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
	writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
}
