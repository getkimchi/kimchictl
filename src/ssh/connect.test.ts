import { existsSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanupTempDirs, jsonResponse, makeTempDir, stubFetch } from "../test-support.js"
import { connectToWorkspace } from "./connect.js"

beforeEach(() => {
	const home = makeTempDir()
	vi.stubEnv("HOME", home)
	vi.stubEnv("KIMCHICTL_HOME", join(home, ".kimchictl"))
	vi.stubEnv("KIMCHI_API_KEY", "key-1")
	vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

const WS = {
	id: "ws-1",
	description: "",
	status: "ACTIVE",
	createTime: "2026-01-01T12:00:00Z",
	uri: "ws-1.remote.kimchi.dev",
	spec: { resources: { cpu: "500m", memory: "1Gi" } },
}

function makeFetch(options?: { suspendedFirst?: boolean }): { fetch: typeof globalThis.fetch; calls: string[] } {
	const calls: string[] = []
	let resumed = false
	const suspendedFirst = options?.suspendedFirst === true
	const fetch = stubFetch(async (url, init) => {
		calls.push(url)
		if (url.endsWith("/workspace-tokens:verifyKey")) return jsonResponse({ organizationId: "org-1" })
		if (url.endsWith("/workspaces/ws-1:resume")) {
			resumed = true
			return jsonResponse({})
		}
		if (url.endsWith("/workspaces/ws-1")) {
			const active = !suspendedFirst || resumed
			return jsonResponse({ ...WS, status: active ? "ACTIVE" : "SUSPENDED" })
		}
		void init
		throw new Error(`unexpected request: ${url}`)
	})
	return { fetch: fetch as typeof globalThis.fetch, calls }
}

describe("connectToWorkspace", () => {
	it("execs ssh to <name>.<domain> with the remote command, no resume when ACTIVE", async () => {
		const { fetch, calls } = makeFetch()
		const execArgs: string[][] = []

		const code = await connectToWorkspace("ws-1", ["uptime"], {
			fetch,
			exec: (args) => {
				execArgs.push(args)
				return 0
			},
		})

		expect(code).toBe(0)
		expect(execArgs).toEqual([["ssh", "ws-1.remote.kimchi.dev", "uptime"]])
		expect(calls.some((c) => c.endsWith(":resume"))).toBe(false)
	})

	it("auto-configures SSH integration on first use", async () => {
		const { fetch } = makeFetch()
		await connectToWorkspace("ws-1", [], { fetch, exec: () => 0 })

		expect(existsSync(join(process.env.KIMCHICTL_HOME ?? "", "ssh_config"))).toBe(true)
	})

	it("skips auto-setup when KIMCHICTL_NO_SSH_SETUP is set", async () => {
		vi.stubEnv("KIMCHICTL_NO_SSH_SETUP", "1")
		const { fetch } = makeFetch()
		await connectToWorkspace("ws-1", [], { fetch, exec: () => 0 })

		expect(existsSync(join(process.env.KIMCHICTL_HOME ?? "", "ssh_config"))).toBe(false)
	})

	it("resumes a suspended workspace, waits for ACTIVE, then connects", async () => {
		const { fetch, calls } = makeFetch({ suspendedFirst: true })
		const execArgs: string[][] = []

		const code = await connectToWorkspace("ws-1", [], {
			fetch,
			sleep: async () => {},
			exec: (args) => {
				execArgs.push(args)
				return 0
			},
		})

		expect(code).toBe(0)
		expect(calls.some((c) => c.endsWith(":resume"))).toBe(true)
		expect(execArgs.length).toBe(1)
	})
})
