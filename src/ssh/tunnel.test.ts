import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, stubFetch } from "../test-support.js"
import { buildWsUrl, resolveTunnel, resumeForConnect, workspaceIdFromRef } from "./tunnel.js"

afterEach(() => {
	vi.unstubAllEnvs()
})

const UUID = "3d3dc322-dd05-4d0c-adab-beb2a0819e69"

const WS_JSON = {
	id: UUID,
	description: "",
	status: "ACTIVE",
	createTime: "2026-01-01T12:00:00Z",
	uri: "ws-1.remote.kimchi.dev",
	spec: { resources: { cpu: "500m", memory: "1Gi" } },
}

interface Call {
	url: string
	init?: RequestInit
}

describe("workspaceIdFromRef", () => {
	it("keeps bare refs and strips a domain suffix", () => {
		expect(workspaceIdFromRef("ws-1")).toBe("ws-1")
		expect(workspaceIdFromRef("ws-1.remote.kimchi.dev")).toBe("ws-1")
	})
})

describe("buildWsUrl", () => {
	it("builds wss://<host>/ssh, no port suffix for 443", () => {
		expect(buildWsUrl("ws-1.remote.kimchi.dev")).toBe("wss://ws-1.remote.kimchi.dev/ssh")
		expect(buildWsUrl("wss://ws-1.remote.kimchi.dev/ws/ssh-proxy")).toBe("wss://ws-1.remote.kimchi.dev/ssh")
	})

	it("appends a non-443 port", () => {
		expect(buildWsUrl("ws-1.remote.kimchi.dev", 8443)).toBe("wss://ws-1.remote.kimchi.dev:8443/ssh")
	})
})

describe("resolveTunnel", () => {
	it("resolves the alias via the workspace list, exchanges a token for the UUID, and assembles the WS URL", async () => {
		const calls: Call[] = []
		const fetch = stubFetch(async (url, init) => {
			calls.push({ url, init })
			if (url.endsWith("/workspace-tokens:verifyKey")) return jsonResponse({ organizationId: "org-1" })
			if (url.includes("?page.limit=")) return jsonResponse({ items: [WS_JSON] })
			if (url.endsWith("/workspace-tokens:exchange")) {
				return jsonResponse({ token: "ws-jwt-1", expireTime: "2026-01-01T01:00:00Z" })
			}
			throw new Error(`unexpected request: ${url}`)
		})

		const creds = await resolveTunnel("key-1", "ws-1.remote.kimchi.dev", { fetch })

		expect(creds).toEqual({ wsUrl: "wss://ws-1.remote.kimchi.dev/ssh", token: "ws-jwt-1" })
		const exchange = calls.find((c) => c.url.endsWith(":exchange"))
		expect(JSON.parse(String(exchange?.init?.body))).toEqual({ workspaceId: UUID })
	})

	it("goes straight to GET for a UUID ref", async () => {
		const fetch = stubFetch(async (url) => {
			if (url.endsWith("/workspace-tokens:verifyKey")) return jsonResponse({ organizationId: "org-1" })
			if (url.endsWith(`/workspaces/${UUID}`)) return jsonResponse(WS_JSON)
			if (url.endsWith("/workspace-tokens:exchange")) return jsonResponse({ token: "ws-jwt-1" })
			throw new Error(`unexpected request: ${url}`)
		})

		const creds = await resolveTunnel("key-1", UUID, { fetch })

		expect(creds).toEqual({ wsUrl: "wss://ws-1.remote.kimchi.dev/ssh", token: "ws-jwt-1" })
	})

	it("surfaces when the workspace has no URI yet", async () => {
		// An alias cannot exist without a URI (alias falls back to the id), so the
		// no-URI state is reachable via a UUID ref to a still-provisioning workspace.
		const fetch = stubFetch(async (url) => {
			if (url.endsWith("/workspace-tokens:verifyKey")) return jsonResponse({ organizationId: "org-1" })
			if (url.endsWith(`/workspaces/${UUID}`)) {
				return jsonResponse({ ...WS_JSON, status: "INITIALIZING", uri: "" })
			}
			throw new Error(`unexpected request: ${url}`)
		})

		await expect(resolveTunnel("key-1", UUID, { fetch })).rejects.toMatchObject({
			message: expect.stringContaining("no connection URI"),
		})
	})
})

describe("resumeForConnect", () => {
	it("POSTs resume with the api key", async () => {
		const calls: Call[] = []
		const fetch = stubFetch(async (url, init) => {
			calls.push({ url, init })
			if (url.endsWith("/workspace-tokens:verifyKey")) return jsonResponse({ organizationId: "org-1" })
			if (url.endsWith(`/workspaces/${UUID}:resume`)) return jsonResponse({})
			throw new Error(`unexpected request: ${url}`)
		})

		await resumeForConnect("key-1", UUID, { fetch })

		const resume = calls.find((c) => c.url.endsWith(":resume"))
		expect(resume?.init?.method).toBe("POST")
		expect(resume?.init?.headers).toMatchObject({ Authorization: "Bearer key-1" })
	})

	it("tolerates 'not suspended' 400s (already running)", async () => {
		const fetch = stubFetch(async (url) => {
			if (url.endsWith("/workspace-tokens:verifyKey")) return jsonResponse({ organizationId: "org-1" })
			if (url.endsWith(`/workspaces/${UUID}:resume`)) return new Response("workspace is not suspended", { status: 400 })
			throw new Error(`unexpected request: ${url}`)
		})

		await expect(resumeForConnect("key-1", UUID, { fetch })).resolves.toBeUndefined()
	})
})
