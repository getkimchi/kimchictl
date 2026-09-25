import { mkdtempSync, readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { captureConsole, jsonResponse, stubFetch } from "../test-support.js"
import { runUpdate, type UpdateDeps } from "./update.js"

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
})

function latestReleaseFetch(version: string): typeof globalThis.fetch {
	return stubFetch(async (url) => {
		if (url.includes("releases/latest")) return jsonResponse({ tag_name: version })
		throw new Error(`unexpected request: ${url}`)
	}) as typeof globalThis.fetch
}

const DIRECTED_DEPS: { [method: string]: Partial<UpdateDeps> } = {
	homebrew: { installMethod: "homebrew" },
	runtime: { installMethod: "runtime" },
}

describe("kimchictl update", () => {
	it("delegates to Homebrew for brew installs", async () => {
		const { lines } = captureConsole()

		const code = await runUpdate([], DIRECTED_DEPS.homebrew as UpdateDeps)

		expect(code).toBe(0)
		expect(lines.join("\n")).toContain("brew upgrade kimchictl")
	})

	it("delegates to npm for runtime installs", async () => {
		const { lines } = captureConsole()

		const code = await runUpdate([], DIRECTED_DEPS.runtime as UpdateDeps)

		expect(code).toBe(0)
		expect(lines.join("\n")).toContain("npm update -g kimchictl")
	})

	it("skips self-update for dev builds", async () => {
		const { lines } = captureConsole()

		const code = await runUpdate([], { installMethod: "binary", currentVersion: "0.0.0-dev" })

		expect(code).toBe(0)
		expect(lines.join("\n")).toContain("Dev build")
	})

	it("reports when already up to date", async () => {
		const { lines } = captureConsole()

		const code = await runUpdate([], {
			installMethod: "binary",
			currentVersion: "0.3.0",
			fetch: latestReleaseFetch("0.3.0"),
		})

		expect(code).toBe(0)
		expect(lines.join("\n")).toContain("already up to date")
	})

	it("downloads and swaps in the new binary", async () => {
		const { lines } = captureConsole()
		const dir = mkdtempSync(join(tmpdir(), "kimchictl-update-test-"))
		const target = join(dir, "kimchictl")
		const payload = Buffer.from("#!/bin/fake new kimchictl\n")

		const code = await runUpdate([], {
			installMethod: "binary",
			currentVersion: "0.2.0",
			targetPath: target,
			fetch: stubFetch(async (url) => {
				if (url.includes("releases/latest")) return jsonResponse({ tag_name: "0.3.0" })
				throw new Error(`unexpected request: ${url}`)
			}) as typeof globalThis.fetch,
			download: async (url, dest) => {
				if (url.endsWith("checksums.txt")) throw new Error("404")
				await writeFile(dest, payload)
			},
		})

		expect(code).toBe(0)
		expect(readFileSync(target)).toEqual(payload)
		expect(lines.join("\n")).toContain("✓ kimchictl 0.3.0 installed")
	})
})
