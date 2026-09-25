import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, stubFetch } from "../test-support.js"
import { buildWsUrl, resolveTunnel, resumeForConnect, workspaceIdFromRef } from "./tunnel.js"

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("workspaceIdFromRef", () => {
	it("keeps bare ids and strips a domain suffix", () => {
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

const WS_JSON = {
	id: "ws-1",
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

describe("resolveTunnel", () => {
	it("exchanges a token and assembles the WS URL", async () => {
		const calls: Call[] = []
		const fetch = stubFetch(async (url, init) => {
			calls.push({ url, init })
			if (url.endsWith("/workspace-tokens:verifyKey")) return jsonResponse({ organizationId: "org-1" })
			if (url.endsWith("/workspace-tokens:exchange")) {
				return jsonResponse({ token: "ws-jwt-1", expireTime: "2026-01-01T01:00:00Z" })
			}
			if (url.endsWith("/workspaces/ws-1")) return jsonResponse(WS_JSON)
			throw new Error(`unexpected request: ${url}`)
		})

		const creds = await resolveTunnel("key-1", "ws-1.remote.kimchi.dev", { fetch })

		expect(creds).toEqual({ wsUrl: "wss://ws-1.remote.kimchi.dev/ssh", token: "ws-jwt-1" })
		const exchange = calls.find((c) => c.url.endsWith(":exchange"))
		expect(JSON.parse(String(exchange?.init?.body))).toEqual({ workspaceId: "ws-1" })
	})

	it("surfaces when the workspace has no URI yet", async () => {
		const fetch = stubFetch(async (url) => {
			if (url.endsWith("/workspace-tokens:verifyKey")) return jsonResponse({ organizationId: "org-1" })
			if (url.endsWith("/workspaces/ws-1")) return jsonResponse({ ...WS_JSON, status: "INITIALIZING", uri: "" })
			throw new Error(`unexpected request: ${url}`)
		})

		await expect(resolveTunnel("key-1", "ws-1", { fetch })).rejects.toMatchObject({
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
			if (url.endsWith("/workspaces/ws-1:resume")) return jsonResponse({})
			throw new Error(`unexpected request: ${url}`)
		})

		await resumeForConnect("key-1", "ws-1", { fetch })

		const resume = calls.find((c) => c.url.endsWith(":resume"))
		expect(resume?.init?.method).toBe("POST")
		expect(resume?.init?.headers).toMatchObject({ Authorization: "Bearer key-1" })
	})

	it("tolerates 'not suspended' 400s (already running)", async () => {
		const fetch = stubFetch(async (url) => {
			if (url.endsWith("/workspace-tokens:verifyKey")) return jsonResponse({ organizationId: "org-1" })
			if (url.endsWith("/workspaces/ws-1:resume")) return new Response("workspace is not suspended", { status: 400 })
			throw new Error(`unexpected request: ${url}`)
		})

		await expect(resumeForConnect("key-1", "ws-1", { fetch })).resolves.toBeUndefined()
	})
})
