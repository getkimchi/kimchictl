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
import { runWhoami } from "./whoami.js"

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

const guardedWhoami = guardCommand(runWhoami)

function seedAuth(dir: string): void {
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ "kimchi-dev": { type: "api_key", key: "key" } }))
}

describe("kimchictl whoami", () => {
	it("prints the profile (text) and the key source on stderr", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		seedAuth(dir)
		const { lines, errors } = captureConsole()
		const fetch = stubFetch(async (url) => {
			expect(url).toBe("https://app.kimchi.dev/api/v1/me")
			return jsonResponse({ id: "user-1", username: "mike", email: "m@example.com" })
		})

		expect(await guardedWhoami([], { fetch })).toBe(0)
		expect(lines).toEqual(["id:       user-1", "username: mike", "email:    m@example.com"])
		expect(errors).toEqual(["(authenticated via auth.json)"])
	})

	it("prints JSON with --output json", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		seedAuth(dir)
		const { lines } = captureConsole()
		const fetch = stubFetch(async () => jsonResponse({ id: "user-1", email: "m@example.com" }))

		expect(await guardedWhoami(["--output", "json"], { fetch })).toBe(0)
		expect(lines).toEqual([JSON.stringify({ id: "user-1", email: "m@example.com" })])
	})

	it("reports not-logged-in via the guard (no stack trace)", async () => {
		stubAgentDirEnv(makeTempDir())
		const { errors } = captureConsole()

		expect(await guardedWhoami([])).toBe(1)
		expect(errors[0]).toMatch(/Not logged in/)
	})

	it("rejects an unknown --output flavor as usage error", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		seedAuth(dir)
		const { errors } = captureConsole()
		const fetch = stubFetch(async () => jsonResponse({ id: "u1" }))

		expect(await guardedWhoami(["--output", "yaml"], { fetch })).toBe(2)
		expect(errors[0]).toMatch(/unsupported --output "yaml"/)
	})
})
