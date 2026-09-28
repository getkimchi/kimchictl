import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { formatAge, formatBytes, formatMillicores } from "../api/resources.js"
import {
	AmbiguousTemplateError,
	type CreateTemplateInput,
	createWorkspaceTemplate,
	getWorkspaceTemplate,
	listWorkspaceTemplates,
	TemplateNotFoundError,
	type WorkspaceTemplate,
	type WorkspaceTemplateSpec,
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
  list    List workspace templates  (alias: ls)
  get     Show template details
  create  Create a workspace template

Options:
  --help   Show this help`

const CREATE_USAGE = `Usage:
  kimchictl templates create [options]

Create a template from a JSON file or from inline flags (not both).

File:
  --file <path>           Read the full template from a JSON file
                          (same shape as 'templates get --output json')

Inline:
  --name <name>           Template name (required, immutable, lowercase)
  --desc <text>            Description
  --cpu <qty>              CPU request (e.g. "500m", "2")
  --memory <qty>           Memory request (e.g. "1Gi", "512Mi")
  --storage <qty>          PVC size (e.g. "20Gi")
  --dep <tool>             CLI tool to install (repeatable, e.g. --dep jq --dep node@22)
  --egress-allow <dest>   Allow egress destination (repeatable)
  --egress-deny <dest>    Deny egress destination (repeatable)
  --egress-default-allow  Default-allow egress (instead of deny-by-default)
  --init-script <script>  Boot script (or @file to read from file)

  --help                  Show this help`

/** `kimchictl templates <verb> …` — read-only browse of workspace templates. */
export async function runTemplates(args: string[], deps: TemplatesDeps = {}): Promise<number> {
	const [verb, ...rest] = args
	switch (verb) {
		case "list":
		case "ls":
			return runTemplatesList(rest, deps)
		case "get":
			return runTemplatesGet(rest, deps)
		case "create":
			return runTemplatesCreate(rest, deps)
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
	if (values.help) {
		console.log(`Usage:
  kimchictl templates list [options]

Options:
  --output <format>   Output format: table | json (default: table)
  --help              Show this help`)
		return 0
	}
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
	if (values.help) {
		console.log(`Usage:
  kimchictl templates get <name-or-id> [options]

Options:
  --output <format>   Output format: text | json (default: text)
  --help              Show this help`)
		return 0
	}
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

async function runTemplatesCreate(args: string[], deps: TemplatesDeps): Promise<number> {
	const { values, positionals } = parseFlags("templates create", args, {
		file: { type: "string", short: "f" },
		name: { type: "string" },
		desc: { type: "string" },
		cpu: { type: "string" },
		memory: { type: "string" },
		storage: { type: "string" },
		dep: { type: "string", multiple: true },
		"egress-allow": { type: "string", multiple: true },
		"egress-deny": { type: "string", multiple: true },
		"egress-default-allow": { type: "boolean" },
		"init-script": { type: "string" },
	})
	if (values.help) {
		console.log(CREATE_USAGE)
		return 0
	}
	if (positionals.length > 0) {
		throw new UsageError("kimchictl templates create: unexpected positional argument")
	}

	let input: CreateTemplateInput

	const file = typeof values.file === "string" && values.file.length > 0 ? values.file : undefined
	if (file) {
		// --file and inline spec flags are mutually exclusive
		const inlineFlags = [
			"cpu",
			"memory",
			"storage",
			"dep",
			"egress-allow",
			"egress-deny",
			"egress-default-allow",
			"init-script",
		]
		const usedInline = inlineFlags.some((f) => values[f] !== undefined)
		if (usedInline) {
			throw new UsageError(
				"kimchictl templates create: --file and inline spec flags are mutually exclusive — the file carries the full definition",
			)
		}
		if (typeof values.name === "string" && values.name.length > 0) {
			throw new UsageError(
				"kimchictl templates create: --file and --name are mutually exclusive (the file carries the name)",
			)
		}
		try {
			const raw = JSON.parse(readFileSync(resolve(file), "utf-8")) as CreateTemplateInput
			if (typeof raw.name !== "string" || raw.name.length === 0) {
				throw new UsageError(`kimchictl templates create: --file: missing required field "name"`)
			}
			input = raw
		} catch (err) {
			if (err instanceof UsageError) throw err
			throw new UsageError(`kimchictl templates create: --file: ${err instanceof Error ? err.message : String(err)}`)
		}
	} else {
		// Inline flags
		const name = typeof values.name === "string" && values.name.length > 0 ? values.name : undefined
		if (!name) {
			throw new UsageError("kimchictl templates create: --name is required (or use --file)")
		}

		const spec: WorkspaceTemplateSpec = {}

		const resources: { cpu?: string; memory?: string; pvcSize?: string } = {}
		if (typeof values.cpu === "string" && values.cpu.length > 0) resources.cpu = values.cpu
		if (typeof values.memory === "string" && values.memory.length > 0) resources.memory = values.memory
		if (typeof values.storage === "string" && values.storage.length > 0) resources.pvcSize = values.storage
		if (Object.keys(resources).length > 0) spec.resources = resources

		const dependencies = (Array.isArray(values.dep) ? values.dep : []).filter(
			(d): d is string => typeof d === "string" && d.length > 0,
		)
		if (dependencies.length > 0) spec.dependencies = dependencies

		const egressAllowed = (Array.isArray(values["egress-allow"]) ? values["egress-allow"] : []).filter(
			(d): d is string => typeof d === "string" && d.length > 0,
		)
		const egressDenied = (Array.isArray(values["egress-deny"]) ? values["egress-deny"] : []).filter(
			(d): d is string => typeof d === "string" && d.length > 0,
		)
		const egressDefaultAllow = values["egress-default-allow"] === true
		if (egressAllowed.length > 0 || egressDenied.length > 0 || egressDefaultAllow) {
			spec.egressPolicy = {
				...(egressDefaultAllow ? { denyByDefault: false } : {}),
				...(egressAllowed.length > 0 ? { allowed: egressAllowed } : {}),
				...(egressDenied.length > 0 ? { denied: egressDenied } : {}),
			}
		}

		const initScriptRaw = typeof values["init-script"] === "string" ? values["init-script"] : undefined
		if (initScriptRaw) {
			if (initScriptRaw.startsWith("@")) {
				const scriptPath = initScriptRaw.slice(1)
				try {
					spec.initScript = readFileSync(resolve(scriptPath), "utf-8")
				} catch {
					throw new UsageError(`kimchictl templates create: --init-script: cannot read ${scriptPath}`)
				}
			} else {
				spec.initScript = initScriptRaw
			}
		}

		input = {
			name,
			description: typeof values.desc === "string" && values.desc.length > 0 ? values.desc : undefined,
			spec: Object.keys(spec).length > 0 ? spec : undefined,
		}
	}

	// Validate the name pattern client-side (must match the proto's validation)
	if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(input.name)) {
		throw new UsageError(
			`kimchictl templates create: name "${input.name}" is invalid — must be lowercase alphanumeric, dots, and dashes (e.g. "rust", "python-django")`,
		)
	}

	const { key } = requireApiKey(deps.env)
	const created = await createWorkspaceTemplate(key, input, { fetch: deps.fetch })
	console.log(`✓ created template ${created.name}`)
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
