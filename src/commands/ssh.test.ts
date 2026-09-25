import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { captureConsole, cleanupTempDirs, makeTempDir } from "../test-support.js"
import { guardCommand } from "./guard.js"
import { runSsh } from "./ssh.js"

beforeEach(() => {
	const home = makeTempDir()
	vi.stubEnv("HOME", home)
	vi.stubEnv("KIMCHICTL_HOME", join(home, ".kimchictl"))
	vi.stubEnv("KIMCHI_API_KEY", "key-1")
})

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

const guard = guardCommand(runSsh)

describe("kimchictl ssh", () => {
	it("prints usage (exit 2) with no subcommand", async () => {
		const { errors } = captureConsole()

		const code = await guard([])

		expect(code).toBe(2)
		expect(errors[0]).toContain("kimchictl ssh <name>")
	})

	it("prints help (exit 0) for ssh help", async () => {
		const { lines } = captureConsole()

		const code = await guard(["help"])

		expect(code).toBe(0)
		expect(lines[0]).toContain("kimchictl ssh <name>")
	})
})

describe("kimchictl ssh setup", () => {
	it("configures integration, reports idempotency on repeat", async () => {
		const { lines } = captureConsole()

		const first = await guard(["setup"])
		expect(first).toBe(0)
		expect(lines.some((line) => line.startsWith("✓ SSH integration configured"))).toBe(true)
		const sshConfigPath = join(process.env.KIMCHICTL_HOME ?? "", "ssh_config")
		expect(readFileSync(sshConfigPath, "utf-8")).toContain("Host *.remote.kimchi.dev")
		expect(readFileSync(join(process.env.HOME ?? "", ".ssh", "config"), "utf-8")).toContain("kimchictl managed include")

		lines.length = 0
		const second = await guard(["setup"])
		expect(second).toBe(0)
		expect(lines[0]).toContain("already configured")
	})

	it("honors --domain", async () => {
		const { lines } = captureConsole()

		await guard(["setup", "--domain", "remote.dev.example"])

		const sshConfigPath = join(process.env.KIMCHICTL_HOME ?? "", "ssh_config")
		expect(readFileSync(sshConfigPath, "utf-8")).toContain("Host *.remote.dev.example")
		expect(lines.some((line) => line.includes("remote.dev.example"))).toBe(true)
	})

	it("--uninstall removes the integration", async () => {
		captureConsole()
		await guard(["setup"])
		const userConfigPath = join(process.env.HOME ?? "", ".ssh", "config")

		const code = await guard(["setup", "--uninstall"])

		expect(code).toBe(0)
		expect(existsSync(join(process.env.KIMCHICTL_HOME ?? "", "ssh_config"))).toBe(false)
		expect(readFileSync(userConfigPath, "utf-8")).not.toContain("kimchictl managed include")
	})

	it("--uninstall on a fresh machine is a clean no-op", async () => {
		const { lines } = captureConsole()

		const code = await guard(["setup", "--uninstall"])

		expect(code).toBe(0)
		expect(lines[0]).toContain("Nothing to remove")
	})
})

describe("kimchictl ssh proxy (usage validation)", () => {
	it("rejects a missing host and a bad port with usage errors (exit 2)", async () => {
		const { errors } = captureConsole()

		expect(await guard(["proxy"])).toBe(2)
		expect(await guard(["proxy", "ws-1.remote.kimchi.dev", "--port", "nope"])).toBe(2)
		expect(errors.some((line) => line.includes("one host"))).toBe(true)
		expect(errors.some((line) => line.includes("--port"))).toBe(true)
	})
})
