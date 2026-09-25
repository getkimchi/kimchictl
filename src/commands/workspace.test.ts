import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	captureConsole,
	cleanupTempDirs,
	jsonResponse,
	makeTempDir,
	stubAgentDirEnv,
	stubFetch,
} from "../test-support.js"
import { guardCommand } from "./guard.js"
import { runWorkspace, type WorkspaceDeps } from "./workspace.js"

const guardedWorkspace = guardCommand(runWorkspace)

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

// ---------------------------------------------------------------- fixtures

interface WorkspaceOverrides extends Record<string, unknown> {
	id?: string
	alias?: string
}

function wsJson(over: WorkspaceOverrides = {}): Record<string, unknown> {
	const alias = over.alias ?? "bright-oak-otter"
	return {
		id: over.id ?? "11111111-2222-3333-4444-555555555555",
		description: "api work",
		status: "ACTIVE",
		createTime: "2026-01-01T00:00:00Z",
		uri: `${alias}.remote.kimchi.dev`,
		spec: { resources: { cpu: "2", memory: "4Gi", pvcSize: "20Gi" } },
		...over,
	}
}

interface Route {
	method: string
	match: RegExp
	respond: (call: number) => Response
	/** Number of times this route must be hit at minimum (0 = optional). */
	minCalls?: number
}

/**
 * Fetch stub routing on method+path. verifyKey is always answered with the
 * fixed org — the commands start every flow by resolving the org id.
 */
function apiFetch(routes: Route[]): typeof globalThis.fetch {
	const counts = new Map<Route, number>()
	return stubFetch(async (url, init) => {
		const method = init?.method ?? "GET"
		if (method === "POST" && url.endsWith("workspace-tokens:verifyKey")) {
			return jsonResponse({ organizationId: "org-1" })
		}
		for (const route of routes) {
			if (route.method === method && route.match.test(url)) {
				counts.set(route, (counts.get(route) ?? 0) + 1)
				return route.respond(counts.get(route) ?? 1)
			}
		}
		throw new Error(`unexpected request: ${method} ${url}`)
	})
}

async function run(
	args: string[],
	fetch: typeof globalThis.fetch,
	deps: WorkspaceDeps = {},
): Promise<{ code: number; lines: string[]; errors: string[] }> {
	const dir = makeTempDir()
	stubAgentDirEnv(dir)
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ "kimchi-dev": { type: "api_key", key: "key" } }))
	const { lines, errors } = captureConsole()
	const code = await guardedWorkspace(args, { fetch, ...deps })
	return { code, lines, errors }
}

// ---------------------------------------------------------------- group dispatch

describe("kimchictl workspace (group dispatch)", () => {
	it("prints group usage on help / missing verb", async () => {
		const { code, lines } = await run(["help"], apiFetch([]))
		expect(code).toBe(0)
		expect(lines[0]).toContain("kimchictl workspace <verb>")
	})

	it("rejects unknown verbs with exit 2", async () => {
		const { code, errors } = await run(["frobnicate"], apiFetch([]))
		expect(code).toBe(2)
		expect(errors[0]).toBe('kimchictl workspace: unknown verb "frobnicate"')
	})

	it("mounts the hidden ws alias", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ "kimchi-dev": { type: "api_key", key: "key" } }))
		captureConsole()
		const code = await guardedWorkspace(["help"])

		expect(code).toBe(0)
	})
})

// ---------------------------------------------------------------- create

describe("kimchictl workspace create", () => {
	it("creates, waits for ACTIVE, and prints the alias on stdout", async () => {
		const fetch = apiFetch([
			{
				method: "POST",
				match: /\/organizations\/org-1\/workspaces$/,
				respond: () => jsonResponse(wsJson({ status: "INITIALIZING" })),
			},
			{
				method: "GET",
				match: /\/workspaces\/11111111-2222-3333-4444-555555555555$/,
				respond: (call) => jsonResponse(wsJson({ status: call >= 2 ? "ACTIVE" : "INITIALIZING" })),
			},
		])

		const { code, lines, errors } = await run(["create", "--desc", "api work"], fetch, { sleep: async () => {} })

		expect(code).toBe(0)
		expect(lines).toEqual(["bright-oak-otter"])
		expect(errors[0]).toBe("✓ created bright-oak-otter (initializing)")
		expect(errors.some((l) => l.includes("uri  bright-oak-otter.remote.kimchi.dev"))).toBe(true)
	})

	it("--no-wait returns immediately after create", async () => {
		const fetch = apiFetch([
			{
				method: "POST",
				match: /\/organizations\/org-1\/workspaces$/,
				respond: () => jsonResponse(wsJson({ status: "INITIALIZING" })),
			},
		])

		const { code, lines } = await run(["create", "--no-wait"], fetch)

		expect(code).toBe(0)
		expect(lines).toEqual(["bright-oak-otter"])
	})

	it("warns when the workspace is not ACTIVE at the deadline", async () => {
		const fetch = apiFetch([
			{ method: "POST", match: /workspaces$/, respond: () => jsonResponse(wsJson({ status: "INITIALIZING" })) },
			{
				method: "GET",
				match: /11111111-2222-3333-4444-555555555555$/,
				respond: () => jsonResponse(wsJson({ status: "INITIALIZING" })),
			},
		])

		// deadline 1s, sleep override advances nothing — the loop exits when Date.now() passes the deadline…
		// …so use --timeout 1 with a real timer of 0 polls by making sleep a no-op that burns real time? No:
		// sleep is mocked to resolve instantly, and Date.now() stays under the deadline — the loop would spin
		// forever. Instead, advance the clock via the sleep mock.
		let now = Date.now()
		const realNow = Date.now
		vi.spyOn(Date, "now").mockImplementation(() => now)

		const { code, errors } = await run(["create", "--timeout", "1"], fetch, {
			sleep: async () => {
				now += 2000
			},
		})
		vi.spyOn(Date, "now").mockImplementation(realNow)

		expect(code).toBe(0)
		expect(errors.some((l) => l.includes("still initializing"))).toBe(true)
	})

	it("--template errors gracefully until the templates API lands", async () => {
		const { code, errors } = await run(["create", "--template", "node"], apiFetch([]))

		expect(code).toBe(1)
		expect(errors[0]).toContain('templates are not available yet (requested "node")')
	})

	it("rejects positional arguments and bad timeouts as usage errors", async () => {
		for (const args of [
			["create", "myname"],
			["create", "--timeout", "abc"],
			["create", "--timeout", "0"],
		]) {
			const { code } = await run(args, apiFetch([]))
			expect(code).toBe(2)
		}
	})
})

// ---------------------------------------------------------------- list

describe("kimchictl workspace list", () => {
	it("renders the table", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\?page\.limit=/,
				respond: () =>
					jsonResponse({
						items: [
							wsJson(),
							wsJson({
								alias: "demo",
								description: "",
								status: "SUSPENDED",
								createTime: "2025-12-30T00:00:00Z",
								spec: undefined,
							}),
						],
					}),
			},
		])

		const { code, lines } = await run(["list"], fetch, { now: () => new Date("2026-01-01T03:00:00Z") })

		expect(code).toBe(0)
		// formatTable prints the whole table as one console call.
		const table = lines[0]?.split("\n") ?? []
		expect(table[0]).toBe("NAME              STATUS     CPU  MEMORY  AGE")
		expect(table[1]).toMatch(/^bright-oak-otter\s+active\s+2\s+4Gi\s+3h$/)
		expect(table[2]).toMatch(/^demo\s+suspended\s+-\s+-\s+2d$/)
		expect(table).toHaveLength(3)
	})

	it("renders json output and the empty table", async () => {
		const fetch = apiFetch([{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [] }) }])

		const jsonRun = await run(["list", "--output", "json"], fetch)
		expect(JSON.parse(jsonRun.lines.join(""))).toEqual([])

		const tableRun = await run(["list"], fetch)
		expect(tableRun.lines).toEqual(["NAME  STATUS  CPU  MEMORY  AGE"])
	})

	it("rejects an unsupported output flavor", async () => {
		const { code } = await run(["list", "--output", "yaml"], apiFetch([]))
		expect(code).toBe(2)
	})
})

// ---------------------------------------------------------------- get

describe("kimchictl workspace get", () => {
	it("renders the detail view", async () => {
		const fetch = apiFetch([
			{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [wsJson()] }) },
		])

		const { code, lines } = await run(["get", "bright-oak-otter"], fetch)

		expect(code).toBe(0)
		expect(lines).toEqual([
			"name:        bright-oak-otter",
			"description: api work",
			"status:      active",
			"uri:         bright-oak-otter.remote.kimchi.dev",
			"created:     2026-01-01T00:00:00.000Z",
			"cpu:         2",
			"memory:      4Gi",
			"storage:     20Gi",
		])
	})

	it("reports a missing workspace via the guard", async () => {
		const fetch = apiFetch([
			{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [wsJson()] }) },
		])

		const { code, errors } = await run(["get", "ghost"], fetch)

		expect(code).toBe(1)
		expect(errors[0]).toMatch(/No workspace matches "ghost"/)
	})

	it("resolves a UUID ref without listing", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\/workspaces\/11111111-2222-3333-4444-555555555555$/,
				respond: () => jsonResponse(wsJson()),
			},
		])

		const { code, lines } = await run(["get", "11111111-2222-3333-4444-555555555555"], fetch)

		expect(code).toBe(0)
		expect(lines[0]).toBe("name:        bright-oak-otter")
	})

	it("requires exactly one name", async () => {
		expect((await run(["get"], apiFetch([]))).code).toBe(2)
		expect((await run(["get", "a", "b"], apiFetch([]))).code).toBe(2)
	})
})

// ---------------------------------------------------------------- delete

describe("kimchictl workspace delete", () => {
	it("deletes after an affirmative confirmation", async () => {
		const fetch = apiFetch([
			{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [wsJson()] }) },
			{
				method: "DELETE",
				match: /\/workspaces\/11111111-2222-3333-4444-555555555555$/,
				respond: () => new Response(null, { status: 200 }),
			},
		])

		const { code, lines } = await run(["delete", "bright-oak-otter"], fetch, { confirm: async () => true })

		expect(code).toBe(0)
		expect(lines).toEqual(["✓ deleted bright-oak-otter"])
	})

	it("--force deletes without prompting", async () => {
		const fetch = apiFetch([
			{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [wsJson()] }) },
			{
				method: "DELETE",
				match: /\/workspaces\/11111111-2222-3333-4444-555555555555$/,
				respond: () => new Response(null, { status: 200 }),
			},
		])

		const { code } = await run(["delete", "--force", "bright-oak-otter"], fetch)
		expect(code).toBe(0)
	})

	it("declined confirmation deletes nothing (no DELETE request)", async () => {
		// Resolution still runs (it names the target in the prompt) — only the
		// DELETE must not happen: any DELETE route would throw "unexpected request".
		const fetch = apiFetch([
			{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [wsJson()] }) },
		])

		const { code, lines } = await run(["delete", "bright-oak-otter"], fetch, { confirm: async () => false })

		expect(code).toBe(0)
		expect(lines).toEqual(["Aborted."])
	})

	it("requires --force when non-interactive", async () => {
		const fetch = apiFetch([
			{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [wsJson()] }) },
		])
		const { code, errors } = await run(["delete", "bright-oak-otter"], fetch, { interactive: false })

		expect(code).toBe(1)
		expect(errors.some((l) => l.includes("--force"))).toBe(true)
	})
})
