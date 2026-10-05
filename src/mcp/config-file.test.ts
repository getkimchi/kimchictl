import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { cleanupTempDirs, makeTempDir } from "../test-support.js"
import { readCastMcpApiKey, writeCastMcpServer } from "./config-file.js"

afterEach(() => {
	cleanupTempDirs()
})

const otherServer = { type: "stdio", command: "other" }

describe("writeCastMcpServer", () => {
	it("creates mcp.json with the cast-mcp entry, mode 0600", () => {
		const mcpPath = join(makeTempDir(), "mcp.json")

		writeCastMcpServer(mcpPath, "new-key")

		expect(JSON.parse(readFileSync(mcpPath, "utf-8"))).toEqual({
			mcpServers: {
				"cast-mcp": {
					type: "http",
					url: "https://api.cast.ai/mcp",
					headers: { Authorization: "Bearer new-key" },
				},
			},
		})
		expect(statSync(mcpPath).mode & 0o777).toBe(0o600)
	})

	it("preserves other servers and fields when setting and removing the entry", () => {
		const mcpPath = join(makeTempDir(), "mcp.json")
		writeFileSync(mcpPath, JSON.stringify({ mcpServers: { other: otherServer }, tuning: 1 }))

		writeCastMcpServer(mcpPath, "new-key")
		expect(JSON.parse(readFileSync(mcpPath, "utf-8"))).toEqual({
			mcpServers: {
				other: otherServer,
				"cast-mcp": {
					type: "http",
					url: "https://api.cast.ai/mcp",
					headers: { Authorization: "Bearer new-key" },
				},
			},
			tuning: 1,
		})

		writeCastMcpServer(mcpPath, undefined)
		expect(JSON.parse(readFileSync(mcpPath, "utf-8"))).toEqual({
			mcpServers: { other: otherServer },
			tuning: 1,
		})
	})

	it("is a no-op removing an entry that is not there (including a missing file)", () => {
		const mcpPath = join(makeTempDir(), "mcp.json")
		writeCastMcpServer(mcpPath, undefined)
		expect(() => statSync(mcpPath)).toThrow()

		writeFileSync(mcpPath, JSON.stringify({ mcpServers: { other: otherServer } }))
		writeCastMcpServer(mcpPath, undefined)
		expect(JSON.parse(readFileSync(mcpPath, "utf-8"))).toEqual({ mcpServers: { other: otherServer } })
	})
})

describe("readCastMcpApiKey", () => {
	it("reads the Bearer token from the cast-mcp entry", () => {
		const mcpPath = join(makeTempDir(), "mcp.json")
		writeFileSync(
			mcpPath,
			JSON.stringify({
				mcpServers: { "cast-mcp": { type: "http", url: "u", headers: { Authorization: "Bearer the-key" } } },
			}),
		)
		expect(readCastMcpApiKey(mcpPath)).toBe("the-key")
	})

	it("returns undefined for missing/corrupt configs, absent entries, and non-Bearer headers", () => {
		const dir = makeTempDir()
		expect(readCastMcpApiKey(join(dir, "nope.json"))).toBeUndefined()

		const corrupt = join(dir, "corrupt.json")
		writeFileSync(corrupt, "{ nope")
		expect(readCastMcpApiKey(corrupt)).toBeUndefined()

		const noEntry = join(dir, "no-entry.json")
		writeFileSync(noEntry, JSON.stringify({ mcpServers: { other: otherServer } }))
		expect(readCastMcpApiKey(noEntry)).toBeUndefined()

		const noBearer = join(dir, "no-bearer.json")
		writeFileSync(noBearer, JSON.stringify({ mcpServers: { "cast-mcp": { headers: { Authorization: "nope" } } } }))
		expect(readCastMcpApiKey(noBearer)).toBeUndefined()
	})
})
