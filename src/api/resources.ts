/**
 * Kubernetes quantity parsing (port of kimchi-dev:src/sandbox/cloud/resources.ts,
 * trimmed to what the workspace list/detail rendering needs) plus display
 * formatters for human tables.
 */

/**
 * Kubernetes quantity: mantissa, then EITHER an exponent OR a decimal/binary
 * SI suffix — never both.
 */
const QUANTITY_RE = /^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)([eE][+-]?[0-9]+|n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/

const DECIMAL_SUFFIX: Record<string, number> = {
	n: 1e-9,
	u: 1e-6,
	m: 1e-3,
	k: 1e3,
	M: 1e6,
	G: 1e9,
	T: 1e12,
	P: 1e15,
	E: 1e18,
}

const BINARY_SUFFIX: Record<string, number> = {
	Ki: 1024,
	Mi: 1024 ** 2,
	Gi: 1024 ** 3,
	Ti: 1024 ** 4,
	Pi: 1024 ** 5,
	Ei: 1024 ** 6,
}

function parseQuantity(raw: unknown): number | undefined {
	if (typeof raw !== "string") return undefined
	const match = QUANTITY_RE.exec(raw.trim())
	if (!match) return undefined
	const mantissa = Number.parseFloat(match[1] ?? "")
	if (!Number.isFinite(mantissa)) return undefined
	const suffix = match[2]
	if (suffix === undefined) return mantissa
	if (/^[eE][+-]?[0-9]+$/.test(suffix)) {
		return mantissa * 10 ** Number.parseInt(suffix.slice(1), 10)
	}
	return mantissa * (BINARY_SUFFIX[suffix] ?? DECIMAL_SUFFIX[suffix] ?? 1)
}

/** "200m" → 200, "1.5" → 1500. Undefined for absent/invalid. */
export function cpuQuantityToMillicores(raw: unknown): number | undefined {
	const cores = parseQuantity(raw)
	return cores === undefined ? undefined : Math.round(cores * 1000)
}

/** "512Mi" → 536870912, "1G" → 1000000000. Undefined for absent/invalid. */
export function byteQuantityToBytes(raw: unknown): number | undefined {
	const bytes = parseQuantity(raw)
	return bytes === undefined ? undefined : Math.round(bytes)
}

/** 1000 → "1", 1500 → "1.5", 250 → "250m", undefined → "-". */
export function formatMillicores(millicores: number | undefined): string {
	if (millicores === undefined) return "-"
	if (millicores < 1000) return `${millicores}m`
	const cores = millicores / 1000
	return Number.isInteger(cores) ? String(cores) : cores.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
}

/** 2147483648 → "2Gi", 536870912 → "512Mi", undefined → "-". */
export function formatBytes(bytes: number | undefined): string {
	if (bytes === undefined) return "-"
	const GI = 1024 ** 3
	const MI = 1024 ** 2
	if (bytes >= GI) return formatUnit(bytes / GI, "Gi")
	if (bytes >= MI) return formatUnit(bytes / MI, "Mi")
	if (bytes >= 1024) return formatUnit(bytes / 1024, "Ki")
	return `${bytes}B`
}

function formatUnit(value: number, suffix: string): string {
	return `${Number.isInteger(value) ? value : value.toFixed(1)}${suffix}`
}

/** Relative age for table columns: "45s", "12m", "3h", "5d". */
export function formatAge(since: Date, now: Date = new Date()): string {
	const seconds = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 48) return `${hours}h`
	return `${Math.floor(hours / 24)}d`
}
