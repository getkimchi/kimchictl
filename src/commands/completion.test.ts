import { afterEach, describe, expect, it, vi } from "vitest"
import { captureConsole } from "../test-support.js"
import { runCompletion } from "./completion.js"
import { guardCommand } from "./guard.js"

afterEach(() => {
	vi.restoreAllMocks()
})

const guard = guardCommand(runCompletion)

describe("kimchictl completion", () => {
	it.each(["bash", "zsh", "fish"])("prints %s completions with the command surface", async (shell) => {
		const { lines } = captureConsole()

		const code = await guard([shell])

		expect(code).toBe(0)
		const script = lines.join("\n")
		for (const name of ["login", "workspace", "ssh", "update"]) {
			expect(script).toContain(name)
		}
	})

	it("rejects unsupported shells with a usage error", async () => {
		const { errors } = captureConsole()

		expect(await guard(["powershell"])).toBe(2)
		expect(errors[0]).toContain("bash, zsh, fish")
	})
})
