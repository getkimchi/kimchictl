import { describe, expect, it } from "vitest"
import { formatTable } from "./table.js"

describe("formatTable", () => {
	it("pads columns to the widest cell and trims trailing whitespace", () => {
		expect(
			formatTable(
				["NAME", "STATUS"],
				[
					["bright-oak-otter", "active"],
					["demo", "suspended"],
				],
			),
		).toBe("NAME              STATUS\nbright-oak-otter  active\n" + "demo              suspended")
	})

	it("renders headers alone when there are no rows", () => {
		expect(formatTable(["A", "B"], [])).toBe("A  B")
	})

	it("tolerates ragged rows", () => {
		expect(formatTable(["A", "B"], [["x"]])).toBe("A  B\nx")
	})
})
