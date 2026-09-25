import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createWorkspaceCommandHandler, default as kimchictlExtension, type PiCommandContext } from "./extension.js"
import { cleanupTempDirs, jsonResponse, makeTempDir, stubAgentDirEnv, stubFetch } from "./test-support.js"

beforeEach(() => {
	const dir = makeTempDir()
	const { home } = stubAgentDirEnv(dir)
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ "kimchi-dev": { type: "api_key", key: "key-1" } }))
	// The list/get flows read the shared config under HOME; keep it absent so
	// auth.json is the source.
	expect(home.length).toBeGreaterThan(0)
})

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
})

const UUID = "3d3dc322-dd05-4d0c-adab-beb2a0819e69"

const WS_JSON = {
	id: UUID,
	description: "api work",
	status: "ACTIVE",
	createTime: "2026-01-01T00:00:00Z",
	uri: "bright-oak-otter.remote.kimchi.dev",
	spec: { resources: { cpu: "2", memory: "4Gi", pvcSize: "20Gi" } },
}

function makeFetch(): { fetch: typeof globalThis.fetch; urls: string[] } {
	const urls: string[] = []
	const fetch = stubFetch(async (url) => {
		urls.push(url)
		if (url.endsWith("/workspace-tokens:verifyKey")) return jsonResponse({ organizationId: "org-1" })
		if (url.includes("?page.limit=")) return jsonResponse({ items: [WS_JSON] })
		throw new Error(`unexpected request: ${url}`)
	})
	return { fetch: fetch as typeof globalThis.fetch, urls }
}

function makeCtx(): { ctx: { ui: { notify: ReturnType<typeof vi.fn> } }; messages: [string, (string | undefined)?][] } {
	const messages: [string, (string | undefined)?][] = []
	const notify = vi.fn((message: string, type?: "info" | "warning" | "error") => messages.push([message, type]))
	return { ctx: { ui: { notify } }, messages }
}

describe("kimchictlExtension (registration)", () => {
	it("registers a single /workspace command", () => {
		const commands: { name: string; options: { handler: (args: string, ctx: PiCommandContext) => Promise<void> } }[] =
			[]
		const pi = {
			registerCommand: (name: string, options: { handler: (args: string, ctx: PiCommandContext) => Promise<void> }) => {
				commands.push({ name, options })
			},
		}

		kimchictlExtension(pi)

		expect(commands.map((c) => c.name)).toEqual(["workspace"])
		expect(typeof commands[0]?.options.handler).toBe("function")
	})
})

describe("/workspace handler", () => {
	it("renders the workspace table for list", async () => {
		const { fetch } = makeFetch()
		const { ctx, messages } = makeCtx()
		const handler = createWorkspaceCommandHandler({ fetch })

		await handler("list", ctx)

		expect(messages.length).toBe(1)
		const [table, type] = messages[0] ?? ["", undefined]
		expect(type).toBeUndefined()
		const lines = table.split("\n")
		expect(lines[0]).toBe("NAME              STATUS  CPU  MEMORY  AGE")
		expect(lines[1]).toMatch(/^bright-oak-otter\s+active\s+2\s+4Gi\s+/)
	})

	it("renders JSON for list --output json", async () => {
		const { fetch } = makeFetch()
		const { ctx, messages } = makeCtx()
		const handler = createWorkspaceCommandHandler({ fetch })

		await handler("list --output json", ctx)

		expect(messages.length).toBe(1)
		const parsed = JSON.parse(messages[0]?.[0] ?? "[]")
		expect(parsed).toEqual([
			{
				id: UUID,
				alias: "bright-oak-otter",
				status: "active",
				uri: "bright-oak-otter.remote.kimchi.dev",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		])
	})

	it("resolves an alias for get and renders the detail lines", async () => {
		const { fetch } = makeFetch()
		const { ctx, messages } = makeCtx()
		const handler = createWorkspaceCommandHandler({ fetch })

		await handler("get bright-oak-otter", ctx)

		expect(messages.length).toBe(1)
		const text = messages[0]?.[0] ?? ""
		expect(text).toContain("name:    bright-oak-otter")
		expect(text).toContain("status:  active")
		expect(text).toContain("uri:     bright-oak-otter.remote.kimchi.dev")
	})

	it("points create/delete at the CLI instead of running them in-session", async () => {
		const { fetch } = makeFetch()
		const { ctx, messages } = makeCtx()
		const handler = createWorkspaceCommandHandler({ fetch })

		await handler("create --desc x", ctx)
		await handler("delete bright-oak-otter", ctx)

		expect(messages.length).toBe(2)
		expect(messages[0]?.[1]).toBe("warning")
		expect(messages[0]?.[0]).toContain("kimchictl workspace")
		expect(messages[1]?.[1]).toBe("warning")
	})

	it("shows usage for no args and errors for unknown verbs", async () => {
		const { ctx, messages } = makeCtx()
		const handler = createWorkspaceCommandHandler()

		await handler("", ctx)
		await handler("frobnicate", ctx)

		expect(messages[0]?.[1]).toBe("warning")
		expect(messages[0]?.[0]).toContain("usage: /workspace")
		expect(messages[1]?.[1]).toBe("error")
		expect(messages[1]?.[0]).toContain('unknown verb "frobnicate"')
	})

	it("surfaces not-logged-in with the harness login hint", async () => {
		// Overwrite auth.json with an empty store for this one test.
		const dir = process.env.KIMCHI_CODING_AGENT_DIR ?? ""
		writeFileSync(join(dir, "auth.json"), "{}")
		const { ctx, messages } = makeCtx()
		const handler = createWorkspaceCommandHandler()

		await handler("list", ctx)

		expect(messages.length).toBe(1)
		expect(messages[0]?.[1]).toBe("error")
		expect(messages[0]?.[0]).toContain("kimchi login")
	})
})
