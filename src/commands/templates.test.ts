import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	captureConsole,
	cleanupTempDirs,
	jsonResponse,
	makeTempDir,
	stubAgentDirEnv,
	stubFetch,
} from "../test-support.js"
import { guardCommand } from "./guard.js"
import { runTemplates, type TemplatesDeps } from "./templates.js"

const guardedTemplates = guardCommand(runTemplates)

beforeEach(() => {
	const dir = makeTempDir()
	stubAgentDirEnv(dir)
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ "kimchi-dev": { type: "api_key", key: "key-1" } }))
})

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

const TEMPLATE_JSON = {
	id: "aaaa1111-2222-3333-4444-555555555555",
	organizationId: "org-1",
	name: "rust",
	description: "Rust workspace",
	spec: {
		resources: { cpu: "2", memory: "4Gi", pvcSize: "20Gi" },
		dependencies: ["jq", "node@22"],
		egressPolicy: { denyByDefault: true, allowed: ["*.github.com"] },
		initScript: "echo hi",
	},
	createdBy: "user-1",
	updatedBy: "user-1",
	createTime: "2026-01-01T00:00:00Z",
	updateTime: "2026-01-01T00:00:00Z",
}

function templateFetch(items: unknown[]): typeof globalThis.fetch {
	return stubFetch(async (url, init) => {
		if (url.endsWith("workspace-tokens:verifyKey")) return jsonResponse({ organizationId: "org-1" })
		if (url.includes("workspace-templates?")) return jsonResponse({ items })
		if (url.endsWith("/workspace-templates/aaaa1111-2222-3333-4444-555555555555")) {
			return jsonResponse(items[0])
		}
		throw new Error(`unexpected: ${init?.method ?? "GET"} ${url}`)
	}) as typeof globalThis.fetch
}

async function run(
	args: string[],
	fetch: typeof globalThis.fetch,
	deps: TemplatesDeps = {},
): Promise<{ code: number; lines: string[]; errors: string[] }> {
	const { lines, errors } = captureConsole()
	const code = await guardedTemplates(args, { color: false, fetch, ...deps })
	return { code, lines, errors }
}

describe("kimchictl templates (top-level)", () => {
	it("prints group usage on help / missing verb", async () => {
		const { code, lines } = await run(["help"], templateFetch([]))
		expect(code).toBe(0)
		expect(lines[0]).toContain("kimchictl templates <verb>")
	})

	it("renders the template table", async () => {
		const { code, lines } = await run(["list"], templateFetch([TEMPLATE_JSON]), {
			now: () => new Date("2026-01-01T03:00:00Z"),
		})
		expect(code).toBe(0)
		const table = lines[0]?.split("\n") ?? []
		expect(table[0]).toMatch(/^NAME\s+DESCRIPTION\s+CPU\s+MEMORY\s+STORAGE\s+AGE$/)
		expect(table[1]).toMatch(/^rust\s+Rust workspace\s+2\s+4Gi\s+20Gi\s+3h$/)
	})

	it("renders json output", async () => {
		const { code, lines } = await run(["list", "--output", "json"], templateFetch([TEMPLATE_JSON]))
		expect(code).toBe(0)
		const parsed = JSON.parse(lines.join(""))
		expect(parsed[0]).toMatchObject({ name: "rust", description: "Rust workspace" })
	})

	it("renders the template detail card by name", async () => {
		const { code, lines } = await run(["get", "rust"], templateFetch([TEMPLATE_JSON]), {
			now: () => new Date("2026-01-01T03:00:00Z"),
		})
		expect(code).toBe(0)
		const text = lines.join("\n")
		expect(text).toContain("rust  template")
		expect(text).toContain("Rust workspace")
		expect(text).toContain("deps  jq, node@22")
		expect(text).toContain("egress  allow: *.github.com")
	})

	it("resolves by UUID without listing", async () => {
		const fetch = templateFetch([TEMPLATE_JSON])
		const calls: string[] = []
		const trackedFetch = stubFetch(async (url, init) => {
			calls.push(url)
			return fetch(url, init)
		}) as typeof globalThis.fetch

		const { code } = await run(["get", "aaaa1111-2222-3333-4444-555555555555"], trackedFetch)
		expect(code).toBe(0)
		expect(calls.some((u) => u.includes("workspace-templates?"))).toBe(false)
	})

	it("errors on unknown template", async () => {
		const { code, errors } = await run(["get", "nope"], templateFetch([]))
		expect(code).toBe(1)
		expect(errors[0]).toContain('No workspace template matches "nope"')
	})

	it("rejects unknown verbs and bad output", async () => {
		expect((await run(["frobnicate"], templateFetch([]))).code).toBe(2)
		expect((await run(["list", "--output", "yaml"], templateFetch([]))).code).toBe(2)
	})
})
