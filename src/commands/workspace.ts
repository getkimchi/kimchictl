import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { resolveWorkspace } from "../api/resolver.js"
import { formatAge, formatBytes, formatMillicores } from "../api/resources.js"
import {
	AmbiguousTemplateError,
	getWorkspaceTemplate,
	listWorkspaceTemplates,
	TemplateNotFoundError,
	type WorkspaceTemplate,
} from "../api/templates.js"
import { waitForWorkspaceActive } from "../api/wait.js"
import {
	type CreateWorkspaceSpec,
	createWorkspace,
	deleteWorkspace,
	listWorkspaces,
	type Workspace,
} from "../api/workspaces.js"
import { requireApiKey } from "../auth/resolve.js"
import { resolveSshDomain } from "../ssh/config.js"
import { parseFlags, UsageError } from "./flags.js"
import { guardCommand } from "./guard.js"
import { confirm, isInteractive } from "./prompt.js"
import { formatTable } from "./table.js"

export interface WorkspaceDeps {
	fetch?: typeof globalThis.fetch
	env?: NodeJS.ProcessEnv
	/** Override TTY interactivity detection (tests). */
	interactive?: boolean
	/** Confirmation override (tests). */
	confirm?: (question: string) => Promise<boolean>
	/** Clock override for deterministic AGE columns (tests). */
	now?: () => Date
	/** Sleep override for the create wait loop (tests). */
	sleep?: (ms: number) => Promise<void>
	/** ANSI colors on stdout (tests); defaults to stdout being a TTY. */
	color?: boolean
}

const GROUP_USAGE = `Usage:
  kimchictl workspace <verb> [options]

Verbs:
  create     Create a workspace (server generates the alias)
  list       List workspaces  (alias: ls)
  get        Show workspace details
  delete     Delete a workspace  (alias: rm)
  templates  Browse workspace templates (list | get)

Create options:
  --desc <text>              Description
  --template <name>          Workspace template (conflicts with spec flags)
  --template-id <uuid>       Template ID (alternative to --template)
  --cpu <qty>               CPU request (e.g. "500m", "2")
  --memory <qty>             Memory request (e.g. "1Gi", "512Mi")
  --storage <qty>            PVC size (e.g. "20Gi")
  --dep <tool>               CLI tool to install (repeatable, e.g. --dep jq --dep node@22)
  --egress-allow <dest>      Allow egress destination (repeatable)
  --egress-deny <dest>       Deny egress destination (repeatable)
  --egress-default-allow     Default-allow egress (instead of deny-by-default)
  --init-script <script>     Boot script (or @file to read from file)
  --no-wait                  Skip waiting for ACTIVE
  --timeout <seconds>        Wait timeout (default 60)

Options:
  --help   Show this help`

/** `kimchictl workspace <verb> …` — group command; also mounted as hidden alias `ws`. */
export async function runWorkspace(args: string[], deps: WorkspaceDeps = {}): Promise<number> {
	const [verb, ...rest] = args
	switch (verb) {
		case "create":
			return runCreate(rest, deps)
		case "list":
		case "ls":
			return runList(rest, deps)
		case "get":
			return runGet(rest, deps)
		case "delete":
		case "rm":
			return runDelete(rest, deps)
		case "templates":
		case "template":
			return runTemplates(rest, deps)
		case "help":
		case "--help":
		case "-h":
		case undefined:
			console.log(GROUP_USAGE)
			return verb === undefined ? 2 : 0
		default:
			console.error(`kimchictl workspace: unknown verb "${verb}"`)
			console.error(GROUP_USAGE)
			return 2
	}
}

// ---------------------------------------------------------------- create

async function runCreate(args: string[], deps: WorkspaceDeps): Promise<number> {
	const { values, positionals } = parseFlags("workspace create", args, {
		desc: { type: "string" },
		template: { type: "string", short: "t" },
		"template-id": { type: "string" },
		cpu: { type: "string" },
		memory: { type: "string" },
		storage: { type: "string" },
		dep: { type: "string", multiple: true },
		"egress-allow": { type: "string", multiple: true },
		"egress-deny": { type: "string", multiple: true },
		"egress-default-allow": { type: "boolean" },
		"init-script": { type: "string" },
		"no-wait": { type: "boolean" },
		timeout: { type: "string", default: "60" },
	})
	if (positionals.length > 0) {
		throw new UsageError(
			"kimchictl workspace create: unexpected positional argument (workspaces are named by the server)",
		)
	}

	const timeoutSeconds = parseTimeoutSeconds(values.timeout, "workspace create")
	const desc = typeof values.desc === "string" && values.desc.length > 0 ? values.desc : undefined

	const templateName = typeof values.template === "string" && values.template.length > 0 ? values.template : undefined
	const templateId =
		typeof values["template-id"] === "string" && values["template-id"].length > 0 ? values["template-id"] : undefined

	// Collect explicit spec parameters from the flags.
	const resources: { cpu?: string; memory?: string; pvcSize?: string } = {}
	if (typeof values.cpu === "string" && values.cpu.length > 0) resources.cpu = values.cpu
	if (typeof values.memory === "string" && values.memory.length > 0) resources.memory = values.memory
	if (typeof values.storage === "string" && values.storage.length > 0) resources.pvcSize = values.storage

	const dependencies = (Array.isArray(values.dep) ? values.dep : []).filter(
		(d): d is string => typeof d === "string" && d.length > 0,
	)
	const egressAllowed = (Array.isArray(values["egress-allow"]) ? values["egress-allow"] : []).filter(
		(d): d is string => typeof d === "string" && d.length > 0,
	)
	const egressDenied = (Array.isArray(values["egress-deny"]) ? values["egress-deny"] : []).filter(
		(d): d is string => typeof d === "string" && d.length > 0,
	)
	const egressDefaultAllow = values["egress-default-allow"] === true
	const initScriptRaw = typeof values["init-script"] === "string" ? values["init-script"] : undefined

	// @file syntax for --init-script: read the script from a file.
	let initScript: string | undefined
	if (initScriptRaw) {
		if (initScriptRaw.startsWith("@")) {
			const filePath = initScriptRaw.slice(1)
			try {
				initScript = readFileSync(resolve(filePath), "utf-8")
			} catch {
				throw new UsageError(`kimchictl workspace create: --init-script: cannot read ${filePath}`)
			}
		} else {
			initScript = initScriptRaw
		}
	}

	const hasSpec =
		Object.keys(resources).length > 0 ||
		dependencies.length > 0 ||
		egressAllowed.length > 0 ||
		egressDenied.length > 0 ||
		egressDefaultAllow ||
		initScript !== undefined

	// Mutual exclusion: template fields and spec parameters cannot coexist
	// (the API rejects both — proto: "conflicts with spec").
	if ((templateName || templateId) && hasSpec) {
		throw new UsageError(
			"kimchictl workspace create: --template and spec flags (--cpu, --memory, --storage, --dep, --egress-*, --init-script) are mutually exclusive — a template provides these values",
		)
	}
	if (templateName && templateId) {
		throw new UsageError("kimchictl workspace create: --template and --template-id are mutually exclusive")
	}

	const spec: CreateWorkspaceSpec | undefined = hasSpec
		? {
				...(Object.keys(resources).length > 0 ? { resources } : {}),
				...(dependencies.length > 0 ? { dependencies } : {}),
				...(egressAllowed.length > 0 || egressDenied.length > 0 || egressDefaultAllow
					? {
							egressPolicy: {
								...(egressDefaultAllow ? { denyByDefault: false } : {}),
								...(egressAllowed.length > 0 ? { allowed: egressAllowed } : {}),
								...(egressDenied.length > 0 ? { denied: egressDenied } : {}),
							},
						}
					: {}),
				...(initScript !== undefined ? { initScript } : {}),
			}
		: undefined

	const { key } = requireApiKey(deps.env)
	const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

	const created = await createWorkspace(key, {
		description: desc,
		templateName,
		templateId,
		spec,
		fetch: deps.fetch,
	})
	// Success-path info goes to stdout (terminals that color stderr red made
	// this look like an error); only warnings and the transient progress
	// spinner stay on stderr.
	console.log(`✓ created ${created.alias} (${created.status})`)

	let current = created
	if (!values["no-wait"]) {
		// kap's create poll: 2s cadence, deadline, progress on stderr.
		current = await waitForWorkspaceActive(key, created.id, {
			fetch: deps.fetch,
			timeoutMs: timeoutSeconds * 1000,
			sleep,
			onTick: (elapsedSeconds) => process.stderr.write(`\r  waiting… ${elapsedSeconds}s`),
		})
		process.stderr.write("\n")
		if (current.status !== "active") {
			console.error(`  ⚠ workspace still initializing — check with: kimchictl workspace get ${created.alias}`)
		}
	}

	if (current.uri) {
		console.log()
		for (const line of connectLines(current, deps.env)) console.log(line)
		console.log()
	}
	// The alias is the last stdout line: ALIAS=$(kimchictl workspace create | tail -1)
	console.log(current.alias)
	return 0
}

function parseTimeoutSeconds(raw: unknown, command: string): number {
	const seconds = typeof raw === "string" ? Number(raw) : Number.NaN
	if (!Number.isInteger(seconds) || seconds <= 0) {
		throw new UsageError(`kimchictl ${command}: --timeout must be a positive number of seconds`)
	}
	return seconds
}

// ---------------------------------------------------------------- list

async function runList(args: string[], deps: WorkspaceDeps): Promise<number> {
	const { values, positionals } = parseFlags("workspace list", args, {
		output: { type: "string", short: "o", default: "table" },
	})
	if (positionals.length > 0) {
		throw new UsageError("kimchictl workspace list: unexpected positional argument")
	}
	if (values.output !== "json" && values.output !== "table") {
		// Validate before touching the network — usage errors fail fast and offline.
		throw new UsageError(
			`kimchictl workspace list: unsupported --output "${String(values.output)}" (expected table|json)`,
		)
	}

	const { key } = requireApiKey(deps.env)
	const workspaces = await listWorkspaces(key, { fetch: deps.fetch })

	if (values.output === "json") {
		console.log(JSON.stringify(workspaces.map(serializeWorkspace), null, 2))
		return 0
	}

	const now = deps.now?.() ?? new Date()
	const rows = workspaces.map((w) => [
		w.alias,
		w.status,
		w.cluster,
		formatAge(w.createdAt, now),
		formatMillicores(w.cpuMillicores),
		formatBytes(w.ramBytes),
		formatBytes(w.pvcSizeBytes),
		w.uri ?? "",
	])
	console.log(formatTable(["NAME", "STATUS", "CLUSTER", "AGE", "CPU", "RAM", "PVC", "URI"], rows))
	return 0
}

// ---------------------------------------------------------------- get

async function runGet(args: string[], deps: WorkspaceDeps): Promise<number> {
	const { values, positionals } = parseFlags("workspace get", args, {
		output: { type: "string", short: "o", default: "text" },
	})
	if (positionals.length !== 1) {
		throw new UsageError("kimchictl workspace get: expected exactly one workspace name")
	}
	if (values.output !== "json" && values.output !== "text") {
		throw new UsageError(
			`kimchictl workspace get: unsupported --output "${String(values.output)}" (expected text|json)`,
		)
	}

	const { key } = requireApiKey(deps.env)
	// Accepts a UUID, full alias, or alias prefix (see api/resolver.ts).
	const workspace = await resolveWorkspace(key, positionals[0] ?? "", { fetch: deps.fetch })

	if (values.output === "json") {
		console.log(JSON.stringify(serializeWorkspace(workspace), null, 2))
		return 0
	}

	const now = deps.now?.() ?? new Date()
	const color = deps.color ?? process.stdout.isTTY === true
	for (const line of renderWorkspaceCard(workspace, deps.env, color, now)) console.log(line)
	return 0
}

// ---------------------------------------------------------------- delete

async function runDelete(args: string[], deps: WorkspaceDeps): Promise<number> {
	const { values, positionals } = parseFlags("workspace delete", args, {
		force: { type: "boolean", short: "f" },
	})
	if (positionals.length !== 1) {
		throw new UsageError("kimchictl workspace delete: expected exactly one workspace name")
	}
	const ref = positionals[0] ?? ""

	const { key } = requireApiKey(deps.env)
	// Resolve before prompting so the confirmation names the real target and
	// typos fail fast instead of after the user answered the prompt.
	const workspace = await resolveWorkspace(key, ref, { fetch: deps.fetch })

	if (!values.force) {
		const interactive = deps.interactive ?? isInteractive()
		const question = `Delete workspace "${workspace.alias}"? [y/N] `
		const ok = await (deps.confirm ? deps.confirm(question) : interactive ? confirm(question) : false)
		if (!ok) {
			if (!deps.confirm && !interactive) {
				console.error(`kimchictl workspace delete: not interactive — re-run with --force to delete ${workspace.alias}`)
				return 1
			}
			console.log("Aborted.")
			return 0
		}
	}

	await deleteWorkspace(key, workspace.id, { fetch: deps.fetch })
	console.log(`✓ deleted ${workspace.alias}`)
	return 0
}

// ---------------------------------------------------------------- templates

async function runTemplates(args: string[], deps: WorkspaceDeps): Promise<number> {
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
			console.error(`kimchictl workspace templates: unknown verb "${verb}"`)
			console.error(TEMPLATES_USAGE)
			return 2
	}
}

const TEMPLATES_USAGE = `Usage:
  kimchictl workspace templates <verb> [options]

Verbs:
  list   List workspace templates  (alias: ls)
  get    Show template details

Options:
  --help   Show this help`

async function runTemplatesList(args: string[], deps: WorkspaceDeps): Promise<number> {
	const { values, positionals } = parseFlags("workspace templates list", args, {
		output: { type: "string", short: "o", default: "table" },
	})
	if (positionals.length > 0) {
		throw new UsageError("kimchictl workspace templates list: unexpected positional argument")
	}
	if (values.output !== "json" && values.output !== "table") {
		throw new UsageError(
			`kimchictl workspace templates list: unsupported --output "${String(values.output)}" (expected table|json)`,
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

async function runTemplatesGet(args: string[], deps: WorkspaceDeps): Promise<number> {
	const { values, positionals } = parseFlags("workspace templates get", args, {
		output: { type: "string", short: "o", default: "text" },
	})
	if (positionals.length !== 1) {
		throw new UsageError("kimchictl workspace templates get: expected exactly one template name or ID")
	}
	if (values.output !== "json" && values.output !== "text") {
		throw new UsageError(
			`kimchictl workspace templates get: unsupported --output "${String(values.output)}" (expected text|json)`,
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
	const lines: string[] = [`${template.name || template.id.slice(0, 12)}  ${dim("template", color)}`]
	if (template.description) lines.push(dim(`  ${template.description}`, color))

	const parts: string[] = []
	const res = template.spec?.resources
	if (res) {
		if (res.cpu) parts.push(formatMillicores(parseQuantity(res.cpu)))
		if (res.memory) parts.push(formatBytes(parseByteQuantity(res.memory)))
	}
	if (parts.length > 0) {
		lines.push(dim(`  ${parts.join(" · ")}`, color))
	}

	const deps = template.spec?.dependencies
	if (deps && deps.length > 0) {
		lines.push(`  deps  ${deps.join(", ")}`)
	}

	const eg = template.spec?.egressPolicy
	if (eg) {
		const egParts: string[] = []
		if (eg.denyByDefault === false) egParts.push("default-allow")
		if (eg.allowed && eg.allowed.length > 0) egParts.push(`allow: ${eg.allowed.join(", ")}`)
		if (eg.denied && eg.denied.length > 0) egParts.push(`deny: ${eg.denied.join(", ")}`)
		if (egParts.length > 0) lines.push(dim(`  egress  ${egParts.join(" · ")}`, color))
	}

	lines.push(dim(`  updated ${formatAge(template.updateTime, now)} ago`, color))
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

// ---------------------------------------------------------------- shared

/** Tinted status dot: green=active, yellow=transitional/suspended, dim=terminated. */
function statusDot(status: Workspace["status"], color: boolean): string {
	if (!color) return `● ${status}`
	const tint = status === "active" ? "\x1b[32m" : status === "terminated" ? "\x1b[2m" : "\x1b[33m"
	return `${tint}● ${status}\x1b[0m`
}

function dim(text: string, color: boolean): string {
	return color ? `\x1b[2m${text}\x1b[0m` : text
}

/** Connect hints shared by `get` and `create`: ssh command + web IDE URL. */
function connectLines(workspace: Workspace, env?: NodeJS.ProcessEnv): string[] {
	if (!workspace.uri) return []
	const domain = resolveSshDomain(undefined, env ?? process.env)
	return ["  Connect:", `    $ ssh ${workspace.alias}.${domain}`, `    $ https://${workspace.uri}/public/ide/`]
}

/** Hero-line card ("Option C"): name+status first, dim metadata, resources, connect block. */
function renderWorkspaceCard(
	workspace: Workspace,
	env: NodeJS.ProcessEnv | undefined,
	color: boolean,
	now: Date,
): string[] {
	const lines: string[] = [`${workspace.alias}  ${statusDot(workspace.status, color)}`]
	if (workspace.description) lines.push(dim(`  ${workspace.description}`, color))

	const meta = [
		workspace.cluster ? `cluster ${workspace.cluster}` : "",
		workspace.clientType,
		`created ${formatAge(workspace.createdAt, now)} ago`,
	].filter(Boolean)
	if (meta.length > 0) lines.push(dim(`  ${meta.join(" · ")}`, color))

	if (
		workspace.cpuMillicores !== undefined ||
		workspace.ramBytes !== undefined ||
		workspace.pvcSizeBytes !== undefined
	) {
		lines.push(
			dim(
				`  ${formatMillicores(workspace.cpuMillicores)} CPU · ${formatBytes(workspace.ramBytes)} memory · ${formatBytes(workspace.pvcSizeBytes)} storage`,
				color,
			),
		)
	}

	const connect = connectLines(workspace, env)
	if (connect.length > 0) {
		lines.push("")
		lines.push(...connect)
	}
	return lines
}

function serializeWorkspace(w: Workspace): Record<string, unknown> {
	return {
		id: w.id,
		alias: w.alias,
		...(w.description ? { description: w.description } : {}),
		status: w.status,
		...(w.cluster ? { cluster: w.cluster } : {}),
		...(w.clientType ? { clientType: w.clientType } : {}),
		...(w.uri ? { uri: w.uri } : {}),
		createdAt: w.createdAt.getTime() > 0 ? w.createdAt.toISOString() : undefined,
		resources: {
			cpuMillicores: w.cpuMillicores,
			ramBytes: w.ramBytes,
			pvcSizeBytes: w.pvcSizeBytes,
		},
	}
}

/**
 * Canonical harness-package entry: modules listed in the kimchi.commands
 * manifest must export run(args) (kimchi-dev:src/commands/package-commands.ts).
 * guardCommand maps usage/domain errors to exit codes 2/1, matching the
 * CLI registry.
 */
export const run: (args: string[], deps?: WorkspaceDeps) => Promise<number> = guardCommand(runWorkspace)
