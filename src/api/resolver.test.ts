import { describe, expect, it } from "vitest"
import { jsonResponse, stubFetch } from "../test-support.js"
import { AmbiguousWorkspaceError, isWorkspaceUuid, resolveWorkspace, WorkspaceNotFoundError } from "./resolver.js"

const UUID = "3d3dc322-dd05-4d0c-adab-beb2a0819e69"

function wsJson(alias: string, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: UUID,
		description: "",
		status: "ACTIVE",
		createTime: "2026-01-01T00:00:00Z",
		uri: `${alias}.remote.kimchi.dev`,
		spec: { resources: { cpu: "1", memory: "2Gi", pvcSize: "10Gi" } },
		...over,
	}
}

function apiFetch(routes: { method: string; match: RegExp; respond: () => Response }[]): typeof globalThis.fetch {
	return stubFetch(async (url, init) => {
		if ((init?.method ?? "GET") === "POST" && url.endsWith("workspace-tokens:verifyKey")) {
			return jsonResponse({ organizationId: "org-1" })
		}
		for (const route of routes) {
			if (route.method === (init?.method ?? "GET") && route.match.test(url)) return route.respond()
		}
		throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`)
	})
}

describe("isWorkspaceUuid", () => {
	it("recognizes UUID shapes only", () => {
		expect(isWorkspaceUuid(UUID)).toBe(true)
		expect(isWorkspaceUuid(UUID.toUpperCase())).toBe(true)
		expect(isWorkspaceUuid("pensive-brainy-kimchi")).toBe(false)
		expect(isWorkspaceUuid("3d3dc322-dd05-4d0c-adab-beb2a0819e6")).toBe(false)
	})
})

describe("resolveWorkspace", () => {
	it("goes straight to GET for a UUID ref (no list call)", async () => {
		const fetch = apiFetch([
			{ method: "GET", match: new RegExp(`/${UUID}$`), respond: () => jsonResponse(wsJson("pensive-brainy")) },
		])

		const ws = await resolveWorkspace("key-1", UUID, { fetch })

		expect(ws.id).toBe(UUID)
		expect(ws.alias).toBe("pensive-brainy")
	})

	it("maps a 404 on the UUID path to WorkspaceNotFoundError", async () => {
		const fetch = apiFetch([
			{ method: "GET", match: new RegExp(`/${UUID}$`), respond: () => new Response("gone", { status: 404 }) },
		])

		await expect(resolveWorkspace("key-1", UUID, { fetch })).rejects.toThrow(WorkspaceNotFoundError)
	})

	it("resolves an exact alias via the workspace list", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\?page\.limit=/,
				respond: () => jsonResponse({ items: [wsJson("bright-oak-otter"), wsJson("pensive-brainy")] }),
			},
		])

		const ws = await resolveWorkspace("key-1", "pensive-brainy", { fetch })

		expect(ws.alias).toBe("pensive-brainy")
		expect(ws.id).toBe(UUID)
	})

	it("resolves a case-insensitive alias prefix", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\?page\.limit=/,
				respond: () => jsonResponse({ items: [wsJson("bright-oak-otter"), wsJson("pensive-brainy")] }),
			},
		])

		const ws = await resolveWorkspace("key-1", "Pensive", { fetch })

		expect(ws.alias).toBe("pensive-brainy")
	})

	it("lists candidates when a prefix is ambiguous", async () => {
		const fetch = apiFetch([
			{
				method: "GET",
				match: /\?page\.limit=/,
				respond: () => jsonResponse({ items: [wsJson("bright-oak-otter"), wsJson("bright-oak-owl")] }),
			},
		])

		await expect(resolveWorkspace("key-1", "bright-oak", { fetch })).rejects.toThrow(AmbiguousWorkspaceError)
		await expect(resolveWorkspace("key-1", "bright-oak", { fetch })).rejects.toThrow(/bright-oak-otter, bright-oak-owl/)
	})

	it("throws WorkspaceNotFoundError when nothing matches", async () => {
		const fetch = apiFetch([
			{ method: "GET", match: /\?page\.limit=/, respond: () => jsonResponse({ items: [wsJson("bright-oak-otter")] }) },
		])

		await expect(resolveWorkspace("key-1", "ghost", { fetch })).rejects.toThrow(/No workspace matches "ghost"/)
	})
})
