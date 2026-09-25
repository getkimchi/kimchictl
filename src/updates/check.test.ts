import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanupTempDirs, jsonResponse, makeTempDir, stubFetch } from "../test-support.js"
import { checkForUpdate, isNewer } from "./check.js"

beforeEach(() => {
	const home = makeTempDir()
	vi.stubEnv("HOME", home)
	vi.stubEnv("KIMCHICTL_HOME", join(home, ".kimchictl"))
	vi.stubEnv("KIMCHICTL_NO_UPDATE_CHECK", "")
})

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
})

describe("isNewer", () => {
	it("compares semver-ish strings numerically", () => {
		expect(isNewer("0.2.0", "0.10.0")).toBe(false)
		expect(isNewer("0.10.0", "0.2.0")).toBe(true)
		expect(isNewer("1.0.0", "1.0.0")).toBe(false)
		expect(isNewer("v0.3.0", "0.2.9")).toBe(true)
	})
})

describe("checkForUpdate", () => {
	it("is silent for dev builds", async () => {
		const fetch = stubFetch(async () => {
			throw new Error("should not fetch")
		})
		expect(await checkForUpdate({ fetch, currentVersion: "0.0.0-dev" })).toBeUndefined()
	})

	it("respects the escape-hatch env var", async () => {
		vi.stubEnv("KIMCHICTL_NO_UPDATE_CHECK", "1")
		const result = await checkForUpdate({
			currentVersion: "0.1.0",
			fetch: stubFetch(async () => {
				throw new Error("should not fetch")
			}),
		})
		expect(result).toBeUndefined()
	})

	it("fetches once a day, notifies only when newer, and caches", async () => {
		let fetches = 0
		const fetch = stubFetch(async (url) => {
			fetches++
			expect(url).toContain("/releases/latest")
			return jsonResponse({ tag_name: "0.3.0" })
		})
		const now = () => new Date("2026-02-01T00:00:00Z")

		const first = await checkForUpdate({ fetch, now, currentVersion: "0.2.0" })
		expect(first).toEqual({ latest: "0.3.0", current: "0.2.0" })

		// Fresh cache — no refetch.
		const second = await checkForUpdate({ fetch, now, currentVersion: "0.2.0" })
		expect(second).toEqual({ latest: "0.3.0", current: "0.2.0" })
		expect(fetches).toBe(1)

		const cachePath = join(process.env.KIMCHICTL_HOME ?? "", "update-check.json")
		expect(existsSync(cachePath)).toBe(true)
		expect(JSON.parse(readFileSync(cachePath, "utf-8"))).toEqual({
			latestVersion: "0.3.0",
			checkedAt: "2026-02-01T00:00:00.000Z",
		})

		// Not newer → quiet.
		const upToDate = await checkForUpdate({ fetch, now, currentVersion: "0.3.0" })
		expect(upToDate).toBeUndefined()
	})

	it("refetches when the cache is stale", async () => {
		let fetches = 0
		const fetch = stubFetch(async () => {
			fetches++
			return jsonResponse({ tag_name: "0.3.0" })
		})
		const day1 = () => new Date("2026-02-01T00:00:00Z")
		const day2 = () => new Date("2026-02-03T12:00:00Z") // >24h later

		await checkForUpdate({ fetch, now: day1, currentVersion: "0.2.0" })
		await checkForUpdate({ fetch, now: day2, currentVersion: "0.2.0" })
		expect(fetches).toBe(2)
	})

	it("never throws on network failure or malformed responses", async () => {
		const failing = stubFetch(async () => {
			throw new Error("offline")
		})
		expect(await checkForUpdate({ fetch: failing, currentVersion: "0.2.0" })).toBeUndefined()

		const weird = stubFetch(async () => jsonResponse({ nope: true }))
		expect(await checkForUpdate({ fetch: weird, currentVersion: "0.2.0" })).toBeUndefined()
	})
})
