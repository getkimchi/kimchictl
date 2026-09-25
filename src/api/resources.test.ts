import { describe, expect, it } from "vitest"
import { byteQuantityToBytes, cpuQuantityToMillicores, formatAge, formatBytes, formatMillicores } from "./resources.js"

describe("quantity parsing", () => {
	it.each([
		["200m", 200],
		["1.5", 1500],
		["2", 2000],
		["1e1", 10000],
	])("cpuQuantityToMillicores(%s) → %d", (input, expected) => {
		expect(cpuQuantityToMillicores(input)).toBe(expected)
	})

	it.each([
		["512Mi", 536870912],
		["1G", 1000000000],
		["1.5Gi", 1610612736],
		["20Gi", 21474836480],
	])("byteQuantityToBytes(%s) → %d", (input, expected) => {
		expect(byteQuantityToBytes(input)).toBe(expected)
	})

	it.each([["not-a-quantity"], ["-5"], ["1e3m"], [""]])("rejects %s", (input) => {
		expect(cpuQuantityToMillicores(input)).toBeUndefined()
		expect(byteQuantityToBytes(input)).toBeUndefined()
	})
})

describe("display formatting", () => {
	it("formats millicores", () => {
		expect(formatMillicores(undefined)).toBe("-")
		expect(formatMillicores(250)).toBe("250m")
		expect(formatMillicores(1000)).toBe("1")
		expect(formatMillicores(1500)).toBe("1.5")
		expect(formatMillicores(2000)).toBe("2")
	})

	it("formats bytes", () => {
		expect(formatBytes(undefined)).toBe("-")
		expect(formatBytes(536870912)).toBe("512Mi")
		expect(formatBytes(2147483648)).toBe("2Gi")
		expect(formatBytes(1610612736)).toBe("1.5Gi")
		expect(formatBytes(2048)).toBe("2Ki")
		expect(formatBytes(100)).toBe("100B")
	})

	it("formats ages", () => {
		const now = new Date("2026-01-02T12:00:00Z")
		expect(formatAge(new Date("2026-01-02T11:59:30Z"), now)).toBe("30s")
		expect(formatAge(new Date("2026-01-02T11:45:00Z"), now)).toBe("15m")
		expect(formatAge(new Date("2026-01-02T09:00:00Z"), now)).toBe("3h")
		expect(formatAge(new Date("2025-12-28T12:00:00Z"), now)).toBe("5d")
		// Clock skew must never produce a negative age.
		expect(formatAge(new Date("2027-01-01T00:00:00Z"), now)).toBe("0s")
	})
})
