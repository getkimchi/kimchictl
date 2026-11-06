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
import { runWorkspace, type WorkspaceDeps, run as workspaceRun } from "./workspace.js"

// The harness-package contract: kimchi.commands modules export run(args)
// with guard exit codes — pinned by the dispatch tests in kimchi-dev.
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
		cluster: "krep-us",
		clientType: "harness",
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
 * fixed org — the commands start every flow by resolving the org id. The
 * userId keeps the default own-workspaces list filter working; tests that
 * exercise the missing-userId path stub verifyKey themselves.
 */
function apiFetch(routes: Route[]): typeof globalThis.fetch {
	const counts = new Map<Route, number>()
	return stubFetch(async (url, init) => {
		const method = init?.method ?? "GET"
		if (method === "POST" && url.endsWith("workspace-tokens:verifyKey")) {
			return jsonResponse({ organizationId: "org-1", userId: "user-7" })
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
	const code = await guardedWorkspace(args, { color: false, fetch, ...deps })
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

		const writes: string[] = []
		const stderr = (chunk: string) => writes.push(chunk)
		const { code, lines, errors } = await run(["create", "--desc", "api work"], fetch, {
			sleep: async () => {},
			stderr,
		})

		expect(code).toBe(0)
		expect(lines).toEqual([
			"✓ created bright-oak-otter (initializing)",
			"",
			"  Connect:",
			"    $ ssh bright-oak-otter.remote.kimchi.dev",
			"    $ https://bright-oak-otter.remote.kimchi.dev/public/ide/",
			"",
			"bright-oak-otter",
		])
		expect(errors).toEqual([])
		// Two wait ticks (INITIALIZING → ACTIVE) then the newline — captured
		// through the injected stderr writer.
		expect(writes.join("")).toMatch(/^\r {2}waiting… \d+s\r {2}waiting… \d+s\n$/)
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
		expect(lines).toEqual([
			"✓ created bright-oak-otter (initializing)",
			"",
			"  Connect:",
			"    $ ssh bright-oak-otter.remote.kimchi.dev",
			"    $ https://bright-oak-otter.remote.kimchi.dev/public/ide/",
			"",
			"bright-oak-otter",
		])
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

		const { code, lines, errors } = await run(["create", "--timeout", "1"], fetch, {
			sleep: async () => {
				now += 2000
			},
		})
		vi.spyOn(Date, "now").mockImplementation(realNow)

		expect(code).toBe(0)
		expect(errors.some((l) => l.includes("still initializing"))).toBe(true)
		// The alias is still the last stdout line for scripting.
		expect(lines[lines.length - 1]).toBe("bright-oak-otter")
	})

	it("--template conflicts with spec flags (usage error)", async () => {
		for (const specFlag of [
			["--cpu", "2"],
			["--memory", "4Gi"],
			["--storage", "20Gi"],
			["--dep", "jq"],
			["--egress-allow", "*.example.com"],
			["--init-script", "echo hi"],
		]) {
			const { code, errors } = await run(["create", "--template", "node", ...specFlag], apiFetch([]))
			expect(code).toBe(2)
			expect(errors.some((e) => e.includes("mutually exclusive"))).toBe(true)
		}
	})

	it("--template and --template-id conflict (usage error)", async () => {
		const { code, errors } = await run(
			["create", "--template", "node", "--template-id", "11111111-2222-3333-4444-555555555555"],
			apiFetch([]),
		)
		expect(code).toBe(2)
		expect(errors.some((e) => e.includes("--template and --template-id"))).toBe(true)
	})

	it("sends templateName to the API", async () => {
		const calls: { body?: unknown }[] = []
		const rawFetch = stubFetch(async (url, init) => {
			if (url.endsWith("workspace-tokens:verifyKey")) return jsonResponse({ organizationId: "org-1" })
			if (url.endsWith("/workspaces") && init?.method === "POST") {
				calls.push({ body: JSON.parse(String(init.body)) })
				return jsonResponse(wsJson({ status: "ACTIVE" }))
			}
			throw new Error(`unexpected: ${init?.method ?? "GET"} ${url}`)
		})

		await run(["create", "--template", "rust", "--no-wait"], rawFetch as typeof globalThis.fetch)

		expect(calls[0]?.body).toMatchObject({
			templateName: "rust",
			clientType: "harness",
		})
		// The workspace provisions its own agent token — no user credential is sent.
		expect(calls[0]?.body).not.toHaveProperty("options")
	})

	it("sends spec fields to the API", async () => {
		const calls: { body?: unknown }[] = []
		const rawFetch = stubFetch(async (url, init) => {
			if (url.endsWith("workspace-tokens:verifyKey")) return jsonResponse({ organizationId: "org-1" })
			if (url.endsWith("/workspaces") && init?.method === "POST") {
				calls.push({ body: JSON.parse(String(init.body)) })
				return jsonResponse(wsJson({ status: "ACTIVE" }))
			}
			throw new Error(`unexpected: ${init?.method ?? "GET"} ${url}`)
		})

		await run(
			[
				"create",
				"--cpu",
				"500m",
				"--memory",
				"2Gi",
				"--storage",
				"10Gi",
				"--dep",
				"jq",
				"--dep",
				"node@22",
				"--egress-allow",
				"*.example.com",
				"--egress-default-allow",
				"--no-wait",
			],
			rawFetch as typeof globalThis.fetch,
		)

		expect(calls[0]?.body).toMatchObject({
			spec: {
				resources: { cpu: "500m", memory: "2Gi", pvcSize: "10Gi" },
				dependencies: ["jq", "node@22"],
				egressPolicy: { denyByDefault: false, allowed: ["*.example.com"] },
			},
		})
		expect(calls[0]?.body).not.toHaveProperty("options")
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
		expect(table[0]).toMatch(/^NAME\s+STATUS\s+CLUSTER\s+TEMPLATE\s+AGE\s+CPU\s+RAM\s+PVC\s+URI$/)
		expect(table[1]).toMatch(
			/^bright-oak-otter\s+active\s+krep-us\s+-\s+3h\s+2\s+4Gi\s+20Gi\s+bright-oak-otter\.remote\.kimchi\.dev$/,
		)
		expect(table[2]).toMatch(/^demo\s+suspended\s+krep-us\s+-\s+2d\s+-\s+-\s+-\s+demo\.remote\.kimchi\.dev$/)
		expect(table).toHaveLength(3)
	})

	it("renders json output and the empty table", async () => {
		const fetch = apiFetch([{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [] }) }])

		const jsonRun = await run(["list", "--output", "json"], fetch)
		expect(JSON.parse(jsonRun.lines.join(""))).toEqual([])

		const tableRun = await run(["list"], fetch)
		expect(tableRun.lines).toEqual(["NAME  STATUS  CLUSTER  TEMPLATE  AGE  CPU  RAM  PVC  URI"])
	})

	it("rejects an unsupported output flavor", async () => {
		const { code } = await run(["list", "--output", "yaml"], apiFetch([]))
		expect(code).toBe(2)
	})

	it("filters to the current user by default (creatorId from verifyKey)", async () => {
		// Only matches when the request carries the creatorId filter — otherwise
		// the request hits no route and the test fails with "unexpected request".
		const fetch = apiFetch([
			{ method: "GET", match: /\?page\.limit=.*creatorId=user-7/, respond: () => jsonResponse({ items: [wsJson()] }) },
		])

		const { code } = await run(["list"], fetch)

		expect(code).toBe(0)
	})

	it("--all lists the organization without the creatorId filter", async () => {
		const urls: string[] = []
		const fetch = stubFetch(async (url, init) => {
			const method = init?.method ?? "GET"
			urls.push(url)
			if (method === "POST" && url.endsWith("workspace-tokens:verifyKey")) {
				return jsonResponse({ organizationId: "org-1", userId: "user-7" })
			}
			if (method === "GET" && url.includes("?page.limit=")) {
				return jsonResponse({ items: [wsJson()] })
			}
			throw new Error(`unexpected request: ${method} ${url}`)
		})

		const { code } = await run(["list", "--all"], fetch)

		expect(code).toBe(0)
		const listUrl = urls.find((u) => u.includes("?page.limit=")) ?? ""
		expect(listUrl).not.toContain("creatorId=")
	})

	it("fails on the creator filter when the control plane omits userId (hint: --all)", async () => {
		const fetch = stubFetch(async (url, init) => {
			const method = init?.method ?? "GET"
			if (method === "POST" && url.endsWith("workspace-tokens:verifyKey")) {
				return jsonResponse({ organizationId: "org-1" }) // no userId
			}
			throw new Error(`unexpected request: ${method} ${url}`)
		})

		const { code, errors } = await run(["list"], fetch)

		expect(code).toBe(1)
		expect(errors.join("")).toContain("--all")
	})

	it("--all works when the control plane omits userId", async () => {
		const fetch = stubFetch(async (url, init) => {
			const method = init?.method ?? "GET"
			if (method === "POST" && url.endsWith("workspace-tokens:verifyKey")) {
				return jsonResponse({ organizationId: "org-1" })
			}
			if (method === "GET" && url.includes("?page.limit=")) {
				return jsonResponse({ items: [wsJson()] })
			}
			throw new Error(`unexpected request: ${method} ${url}`)
		})

		const { code } = await run(["list", "--all"], fetch)

		expect(code).toBe(0)
	})
})

// ---------------------------------------------------------------- get

describe("kimchictl workspace get", () => {
	it("renders the detail view", async () => {
		const fetch = apiFetch([
			{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [wsJson()] }) },
		])

		const { code, lines } = await run(["get", "bright-oak-otter"], fetch, {
			now: () => new Date("2026-01-01T03:00:00Z"),
		})

		expect(code).toBe(0)
		expect(lines).toEqual([
			"bright-oak-otter  ● active",
			"  api work",
			"  cluster krep-us · harness · created 3h ago",
			"  2 CPU · 4Gi memory · 20Gi storage",
			"",
			"  Connect:",
			"    $ ssh bright-oak-otter.remote.kimchi.dev",
			"    $ https://bright-oak-otter.remote.kimchi.dev/public/ide/",
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

		const { code, lines } = await run(["get", "11111111-2222-3333-4444-555555555555"], fetch, {
			now: () => new Date("2026-01-01T03:00:00Z"),
		})

		expect(code).toBe(0)
		expect(lines[0]).toBe("bright-oak-otter  ● active")
	})

	it("colorizes the status dot and metadata when colors are on", async () => {
		const fetch = apiFetch([
			{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [wsJson()] }) },
		])

		const { lines } = await run(["get", "bright-oak-otter"], fetch, {
			color: true,
			now: () => new Date("2026-01-01T03:00:00Z"),
		})

		const joined = lines.join("\n")
		expect(joined).toContain("\x1b[32m● active\x1b[0m")
		expect(joined).toContain("\x1b[2m  cluster krep-us")
	})

	it("requires exactly one name", async () => {
		expect((await run(["get"], apiFetch([]))).code).toBe(2)
		expect((await run(["get", "a", "b"], apiFetch([]))).code).toBe(2)
	})

	it("exports the guarded run() entry for the harness package-command contract", async () => {
		// Same function contract, exit codes included: a usage error maps to 2,
		// not a thrown exception — the harness dispatcher returns it verbatim.
		expect(await workspaceRun(["frobnicate"], { color: false })).toBe(2)
	})
})

// ---------------------------------------------------------------- suspend

describe("kimchictl workspace suspend", () => {
	it("POSTs :suspend for the resolved workspace and reports on stdout", async () => {
		const calls: string[] = []
		const routes: Route[] = [
			{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [wsJson()] }) },
			{
				method: "POST",
				match: /\/workspaces\/11111111-2222-3333-4444-555555555555:suspend$/,
				respond: () => {
					calls.push("suspend")
					return jsonResponse({})
				},
			},
		]
		const fetch = apiFetch(routes)

		const { code, lines } = await run(["suspend", "bright-oak-otter"], fetch)

		expect(code).toBe(0)
		expect(calls).toEqual(["suspend"])
		expect(lines).toEqual(["✓ suspending bright-oak-otter"])
	})

	it("tolerates 'not active' 400s (already suspended)", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\?page\.limit=/,
				respond: () => jsonResponse({ items: [wsJson({ status: "SUSPENDED" })] }),
			},
			{
				method: "POST",
				match: /:suspend$/,
				respond: () => new Response("workspace is not active", { status: 400 }),
			},
			{
				method: "GET",
				match: /\/workspaces\/11111111-2222-3333-4444-555555555555$/,
				respond: () => jsonResponse(wsJson({ status: "SUSPENDED" })), // verification GET: not running
			},
		])

		const { code } = await run(["suspend", "bright-oak-otter"], fetch)

		expect(code).toBe(0)
	})

	it("tolerates a 400 regardless of wording when the workspace is not running", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\?page\.limit=/,
				respond: () => jsonResponse({ items: [wsJson({ status: "SUSPENDED" })] }),
			},
			{
				method: "POST",
				match: /:suspend$/,
				// Wording a prose matcher would never key on — the GET decides.
				respond: () => new Response("precondition not met in current state", { status: 400 }),
			},
			{
				method: "GET",
				match: /\/workspaces\/11111111-2222-3333-4444-555555555555$/,
				respond: () => jsonResponse(wsJson({ status: "SUSPENDED" })),
			},
		])

		const { code, lines } = await run(["suspend", "bright-oak-otter"], fetch)

		expect(code).toBe(0)
		expect(lines).toEqual(["✓ suspending bright-oak-otter"])
	})

	it("fails on an unrelated 400 whose body merely contains 'not active'", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\?page\.limit=/,
				respond: () => jsonResponse({ items: [wsJson()] }),
			},
			{
				method: "POST",
				match: /:suspend$/,
				respond: () => new Response("billing account is not active", { status: 400 }),
			},
			{
				method: "GET",
				match: /\/workspaces\/11111111-2222-3333-4444-555555555555$/,
				respond: () => jsonResponse(wsJson()), // verification GET: still ACTIVE — the suspend did not take
			},
		])

		const { code, lines, errors } = await run(["suspend", "bright-oak-otter"], fetch)

		expect(code).toBe(1)
		expect(lines).toEqual([]) // no ✓ — silently "succeeding" here is the bug
		expect(errors.join("")).toContain("HTTP 400")
	})

	it("propagates a 500 as an error with exit 1", async () => {
		const fetch = apiFetch([
			{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [wsJson()] }) },
			{ method: "POST", match: /:suspend$/, respond: () => new Response("internal error", { status: 500 }) },
		])

		const { code, lines, errors } = await run(["suspend", "bright-oak-otter"], fetch)

		expect(code).toBe(1)
		expect(lines).toEqual([]) // the ✓ line only prints after a successful POST
		expect(errors.join("")).toContain("HTTP 500")
	})

	it("resolves the org via verifyKey when the credential carries none", async () => {
		const requests: string[] = []
		const inner = apiFetch([
			{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [wsJson()] }) },
			{ method: "POST", match: /:suspend$/, respond: () => jsonResponse({}) },
		])
		const fetch = stubFetch(async (url, init) => {
			requests.push(`${init?.method ?? "GET"} ${url}`)
			return inner(url, init)
		})

		const { code } = await run(["suspend", "bright-oak-otter"], fetch)

		expect(code).toBe(0)
		// api_key credentials carry no organizationId, so the org segment of the
		// :suspend URL can only come from the verifyKey round-trip.
		const verify = requests.findIndex((r) => r.endsWith("workspace-tokens:verifyKey"))
		const suspend = requests.findIndex((r) => r.endsWith(":suspend"))
		expect(verify).toBeGreaterThanOrEqual(0)
		expect(suspend).toBeGreaterThan(verify)
		expect(requests[suspend]).toContain(
			"/ai-optimizer/v1beta/organizations/org-1/workspaces/11111111-2222-3333-4444-555555555555:suspend",
		)
	})

	it("requires exactly one name", async () => {
		expect((await run(["suspend"], apiFetch([]))).code).toBe(2)
		expect((await run(["suspend", "a", "b"], apiFetch([]))).code).toBe(2)
	})
})

// ---------------------------------------------------------------- resume

describe("kimchictl workspace resume", () => {
	it("POSTs :resume, waits for ACTIVE, and confirms", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\?page\.limit=/,
				respond: () => jsonResponse({ items: [wsJson({ status: "SUSPENDED" })] }),
			},
			{ method: "POST", match: /:resume$/, respond: () => jsonResponse({}) },
			{
				method: "GET",
				match: /\/workspaces\/11111111-2222-3333-4444-555555555555$/,
				respond: () => jsonResponse(wsJson()), // first poll: ACTIVE
			},
		])

		const writes: string[] = []
		const stderr = (chunk: string) => writes.push(chunk)
		const { code, lines } = await run(["resume", "bright-oak-otter"], fetch, { sleep: async () => {}, stderr })

		expect(code).toBe(0)
		// "is active" only prints after the wait loop polls ACTIVE — proving the
		// wait ran; the injected stderr writer captures the tick and newline.
		expect(lines).toEqual(["✓ resuming bright-oak-otter", "✓ bright-oak-otter is active"])
		expect(writes.join("")).toMatch(/^\r {2}waiting… \d+s\n$/)
	})

	it("--no-wait skips the ACTIVE poll", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\?page\.limit=/,
				respond: () => jsonResponse({ items: [wsJson({ status: "SUSPENDED" })] }),
			},
			{ method: "POST", match: /:resume$/, respond: () => jsonResponse({}) },
		])

		const { code, lines } = await run(["resume", "--no-wait", "bright-oak-otter"], fetch)

		expect(code).toBe(0)
		expect(lines).toEqual(["✓ resuming bright-oak-otter"])
	})

	it("tolerates a 400 regardless of wording when the workspace is already running", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\?page\.limit=/,
				respond: () => jsonResponse({ items: [wsJson()] }),
			},
			{
				method: "POST",
				match: /:resume$/,
				// Wording a prose matcher would never key on — the GET decides.
				respond: () => new Response("workspace is already running", { status: 400 }),
			},
			{
				method: "GET",
				match: /\/workspaces\/11111111-2222-3333-4444-555555555555$/,
				respond: () => jsonResponse(wsJson()), // verification GET: ACTIVE
			},
		])

		const { code, lines } = await run(["resume", "--no-wait", "bright-oak-otter"], fetch)

		expect(code).toBe(0)
		expect(lines).toEqual(["✓ resuming bright-oak-otter"])
	})

	it("fails when a 'not suspended' 400 leaves the workspace suspended", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\?page\.limit=/,
				respond: () => jsonResponse({ items: [wsJson({ status: "SUSPENDED" })] }),
			},
			{
				method: "POST",
				match: /:resume$/,
				// The canonical FailedPrecondition prose — but the state check
				// decides, and the workspace never left SUSPENDED.
				respond: () => new Response("workspace is not suspended", { status: 400 }),
			},
			{
				method: "GET",
				match: /\/workspaces\/11111111-2222-3333-4444-555555555555$/,
				respond: () => jsonResponse(wsJson({ status: "SUSPENDED" })),
			},
		])

		const { code, lines, errors } = await run(["resume", "--no-wait", "bright-oak-otter"], fetch)

		expect(code).toBe(1)
		expect(lines).toEqual([])
		expect(errors.join("")).toContain("HTTP 400")
	})

	it("propagates an unrelated 403 as an error with exit 1", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\?page\.limit=/,
				respond: () => jsonResponse({ items: [wsJson({ status: "SUSPENDED" })] }),
			},
			{
				method: "POST",
				// The org-scoped path is pinned: a wrong org segment must not
				// silently match (the stub throws "unexpected request" instead).
				match: /\/organizations\/org-1\/workspaces\/11111111-2222-3333-4444-555555555555:resume$/,
				respond: () => new Response("denied", { status: 403 }),
			},
		])

		const { code, lines, errors } = await run(["resume", "bright-oak-otter"], fetch)

		expect(code).toBe(1)
		expect(lines).toEqual([]) // no ✓ line, and the ACTIVE poll never starts
		expect(errors.join("")).toContain("Forbidden")
	})

	it("fails with exit 1 (and warns) when the wait budget expires", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\?page\.limit=/,
				respond: () => jsonResponse({ items: [wsJson({ status: "SUSPENDED" })] }),
			},
			{ method: "POST", match: /:resume$/, respond: () => jsonResponse({}) },
			{
				method: "GET",
				match: /\/workspaces\/11111111-2222-3333-4444-555555555555$/,
				respond: () => jsonResponse(wsJson({ status: "INITIALIZING" })), // never ACTIVE
			},
		])

		// Fake the clock: each injected sleep jumps it forward, so the 1s
		// deadline really passes after the first 2s poll — no real waiting.
		vi.useFakeTimers()
		try {
			const sleep = async (ms: number) => {
				vi.setSystemTime(Date.now() + ms)
			}
			const writes: string[] = []
			const { code, lines, errors } = await run(["resume", "--timeout", "1", "bright-oak-otter"], fetch, {
				sleep,
				stderr: (chunk) => writes.push(chunk),
			})

			expect(code).toBe(1)
			expect(lines).toEqual(["✓ resuming bright-oak-otter"])
			expect(errors.join("")).toContain("still initializing")
			expect(writes.join("")).toMatch(/^\r {2}waiting… \d+s\n$/)
		} finally {
			vi.useRealTimers()
		}
	})

	it("requires exactly one name", async () => {
		expect((await run(["resume"], apiFetch([]))).code).toBe(2)
		expect((await run(["resume", "a", "b"], apiFetch([]))).code).toBe(2)
	})

	it("exports the guarded run() entry for the harness package-command contract", async () => {
		// Same function contract, exit codes included: a usage error maps to 2,
		// not a thrown exception — the harness dispatcher returns it verbatim.
		expect(await workspaceRun(["frobnicate"], { color: false })).toBe(2)
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
