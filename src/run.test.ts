import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { run } from "./run.js"
import { VERSION } from "./version.js"

describe("run dispatcher", () => {
	let logLines: string[]
	let errorLines: string[]

	beforeEach(() => {
		logLines = []
		errorLines = []
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logLines.push(args.map(String).join(" "))
		})
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errorLines.push(args.map(String).join(" "))
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("prints help and exits 0 with no args", async () => {
		expect(await run([])).toBe(0)
		expect(logLines.some((line) => line.includes("Usage:"))).toBe(true)
	})

	it("prints help for `help`, --help and -h", async () => {
		for (const args of [["help"], ["--help"], ["-h"]]) {
			expect(await run(args)).toBe(0)
		}
		expect(logLines.filter((line) => line.includes("Usage:"))).toHaveLength(3)
	})

	it("prints the version for the version command and --version / -v", async () => {
		for (const args of [["version"], ["--version"], ["-v"]]) {
			expect(await run(args)).toBe(0)
		}
		expect(logLines).toEqual([`kimchictl ${VERSION}`, `kimchictl ${VERSION}`, `kimchictl ${VERSION}`])
	})

	it("exits 2 and reports an unknown command, without printing help to stdout", async () => {
		expect(await run(["frobnicate"])).toBe(2)
		expect(errorLines[0]).toBe('kimchictl: unknown command "frobnicate"')
		expect(logLines).toHaveLength(0)
	})

	it("omits hidden commands from help", async () => {
		await run([])
		expect(logLines.some((line) => line.includes("version"))).toBe(true)
	})
})
