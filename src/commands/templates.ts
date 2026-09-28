import { formatAge, formatBytes, formatMillicores } from "../api/resources.js"
import {
	AmbiguousTemplateError,
	getWorkspaceTemplate,
	listWorkspaceTemplates,
	TemplateNotFoundError,
	type WorkspaceTemplate,
} from "../api/templates.js"
import { requireApiKey } from "../auth/resolve.js"
import { parseFlags, UsageError } from "./flags.js"
import { guardCommand } from "./guard.js"
import { formatTable } from "./table.js"

export interface TemplatesDeps {
	fetch?: typeof globalThis.fetch
	env?: NodeJS.ProcessEnv
	/** Override TTY interactivity detection (tests). */
	interactive?: boolean
	/** Clock override for deterministic AGE columns (tests). */
	now?: () => Date
	/** ANSI colors on stdout (tests); defaults to stdout being a TTY. */
	color?: boolean
}

const TEMPLATES_USAGE = `Usage:
  kimchictl templates <verb> [options]

Verbs:
  list   List workspace templates  (alias: ls)
  get    Show template details

Options:
  --help   Show this help`

/** `kimchictl templates <verb> …` — read-only browse of workspace templates. */
export async function runTemplates(args: string[], deps: TemplatesDeps = {}): Promise<number> {
	const [verb, ...rest] = args
	switch (verb) {
		case "list":
		case "ls":
			return runTemplatesList(rest, deps)
		case "get":
			return runTemplatesGet(rest, deps)
		case "help":
		case "--help":
		case "-h":
			console.log(TEMPLATES_USAGE)
			return 0
		case undefined:
			console.error(TEMPLATES_USAGE)
			return 2
		default:
			console.error(`kimchictl templates: unknown verb "${verb}"`)
			console.error(TEMPLATES_USAGE)
			return 2
	}
}

async function runTemplatesList(args: string[], deps: TemplatesDeps): Promise<number> {
	const { values, positionals } = parseFlags("templates list", args, {
		output: { type: "string", short: "o", default: "table" },
	})
	if (positionals.length > 0) {
		throw new UsageError("kimchictl templates list: unexpected positional argument")
	}
	if (values.output !== "json" && values.output !== "table") {
		throw new UsageError(
			`kimchictl templates list: unsupported --output "${String(values.output)}" (expected table|json)`,
		)
	}

	const { key } = requireApiKey(deps.env)
	const templates = await listWorkspaceTemplates(key, { fetch: deps.fetch })

	if (values.output === "json") {
		console.log(JSON.stringify(templates.map(serializeTemplate), null, 2))
		return 0
	}

	const now = deps.now?.() ?? new Date()
	const rows = templates.map((t) => [
		t.name || t.id.slice(0, 12),
		t.description.length > 40 ? `${t.description.slice(0, 37)}…` : t.description || "-",
		formatMillicores(t.spec?.resources?.cpu ? parseQuantity(t.spec.resources.cpu) : undefined),
		formatBytes(t.spec?.resources?.memory ? parseByteQuantity(t.spec.resources.memory) : undefined),
		formatBytes(t.spec?.resources?.pvcSize ? parseByteQuantity(t.spec.resources.pvcSize) : undefined),
		formatAge(t.createTime, now),
	])
	console.log(formatTable(["NAME", "DESCRIPTION", "CPU", "MEMORY", "STORAGE", "AGE"], rows))
	return 0
}

async function runTemplatesGet(args: string[], deps: TemplatesDeps): Promise<number> {
	const { values, positionals } = parseFlags("templates get", args, {
		output: { type: "string", short: "o", default: "text" },
	})
	if (positionals.length !== 1) {
		throw new UsageError("kimchictl templates get: expected exactly one template name or ID")
	}
	if (values.output !== "json" && values.output !== "text") {
		throw new UsageError(
			`kimchictl templates get: unsupported --output "${String(values.output)}" (expected text|json)`,
		)
	}

	const { key } = requireApiKey(deps.env)
	const ref = positionals[0] ?? ""

	// Templates are addressed by ID in the API; when the ref is a name,
	// list-and-match (the API has no by-name lookup).
	let template: WorkspaceTemplate | undefined
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
		template = await getWorkspaceTemplate(key, ref, { fetch: deps.fetch })
	} else {
		const all = await listWorkspaceTemplates(key, { fetch: deps.fetch })
		const matches = all.filter((t) => t.name === ref || t.name.startsWith(ref))
		if (matches.length === 0) throw new TemplateNotFoundError(ref)
		if (matches.length > 1)
			throw new AmbiguousTemplateError(
				ref,
				matches.map((t) => t.name),
			)
		template = matches[0]
	}
	if (!template) throw new TemplateNotFoundError(ref)

	if (values.output === "json") {
		console.log(JSON.stringify(serializeTemplate(template), null, 2))
		return 0
	}

	for (const line of renderTemplateCard(template, deps.color ?? false, deps.now?.() ?? new Date())) {
		console.log(line)
	}
	return 0
}

function renderTemplateCard(template: WorkspaceTemplate, color: boolean, now: Date): string[] {
	const dimText = (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text)
	const lines: string[] = [`${template.name || template.id.slice(0, 12)}  ${dimText("template")}`]
	if (template.description) lines.push(dimText(`  ${template.description}`))

	const parts: string[] = []
	const res = template.spec?.resources
	if (res) {
		if (res.cpu) parts.push(formatMillicores(parseQuantity(res.cpu)))
		if (res.memory) parts.push(formatBytes(parseByteQuantity(res.memory)))
	}
	if (parts.length > 0) {
		lines.push(dimText(`  ${parts.join(" · ")}`))
	}

	const dependencies = template.spec?.dependencies
	if (dependencies && dependencies.length > 0) {
		lines.push(`  deps  ${dependencies.join(", ")}`)
	}

	const eg = template.spec?.egressPolicy
	if (eg) {
		const egParts: string[] = []
		if (eg.denyByDefault === false) egParts.push("default-allow")
		if (eg.allowed && eg.allowed.length > 0) egParts.push(`allow: ${eg.allowed.join(", ")}`)
		if (eg.denied && eg.denied.length > 0) egParts.push(`deny: ${eg.denied.join(", ")}`)
		if (egParts.length > 0) lines.push(dimText(`  egress  ${egParts.join(" · ")}`))
	}

	lines.push(dimText(`  updated ${formatAge(template.updateTime, now)} ago`))
	return lines
}

function serializeTemplate(t: WorkspaceTemplate): Record<string, unknown> {
	return {
		id: t.id,
		name: t.name,
		...(t.description ? { description: t.description } : {}),
		spec: t.spec,
		...(t.createdBy ? { createdBy: t.createdBy } : {}),
		...(t.updateTime.getTime() > 0 ? { updateTime: t.updateTime.toISOString() } : {}),
	}
}

/** Parse a k8s CPU quantity string ("500m", "2") to millicores. */
function parseQuantity(q: string): number | undefined {
	const value = Number.parseFloat(q.replace(/m$/, ""))
	if (Number.isNaN(value)) return undefined
	return q.endsWith("m") ? value : value * 1000
}

/** Parse a k8s memory/storage quantity string ("1Gi", "512Mi") to bytes. */
function parseByteQuantity(q: string): number | undefined {
	const units: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }
	for (const [suffix, mult] of Object.entries(units)) {
		if (q.endsWith(suffix)) {
			const value = Number.parseFloat(q.slice(0, -suffix.length))
			if (!Number.isNaN(value)) return value * mult
		}
	}
	const value = Number.parseFloat(q)
	if (!Number.isNaN(value)) return value
	return undefined
}

/** Canonical harness-package entry: guard exit codes for the kimchi.commands manifest. */
export const run: (args: string[], deps?: TemplatesDeps) => Promise<number> = guardCommand(runTemplates)
