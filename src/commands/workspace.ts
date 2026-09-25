import { resolveWorkspace } from "../api/resolver.js"
import { formatAge, formatBytes, formatMillicores } from "../api/resources.js"
import { resolveTemplate } from "../api/templates.js"
import { waitForWorkspaceActive } from "../api/wait.js"
import { createWorkspace, deleteWorkspace, listWorkspaces, type Workspace } from "../api/workspaces.js"
import { requireApiKey } from "../auth/resolve.js"
import { parseFlags, UsageError } from "./flags.js"
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
}

const GROUP_USAGE = `Usage:
  kimchictl workspace <verb> [options]

Verbs:
  create   Create a workspace (server generates the alias)
  list     List workspaces  (alias: ls)
  get      Show workspace details
  delete   Delete a workspace  (alias: rm)

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
		"no-wait": { type: "boolean" },
		timeout: { type: "string", default: "60" },
	})
	if (positionals.length > 0) {
		throw new UsageError(
			"kimchictl workspace create: unexpected positional argument (workspaces are named by the server)",
		)
	}

	const template = values.template
	if (typeof template === "string" && template.length > 0) {
		// Placeholder: errors gracefully until the templates API contract lands.
		resolveTemplate(template)
	}
	if (values.template !== undefined && (typeof values.template !== "string" || values.template.length === 0)) {
		throw new UsageError("kimchictl workspace create: --template must not be empty")
	}

	const timeoutSeconds = parseTimeoutSeconds(values.timeout, "workspace create")
	const desc = typeof values.desc === "string" && values.desc.length > 0 ? values.desc : undefined

	const { key } = requireApiKey(deps.env)
	const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

	const created = await createWorkspace(key, { description: desc, fetch: deps.fetch })
	console.error(`✓ created ${created.alias} (${created.status})`)

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

	if (current.uri) console.error(`  uri  ${current.uri}`)
	// The alias goes to stdout last so scripts can capture it: ALIAS=$(kimchictl workspace create)
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
		formatMillicores(w.cpuMillicores),
		formatBytes(w.ramBytes),
		formatAge(w.createdAt, now),
	])
	console.log(formatTable(["NAME", "STATUS", "CPU", "MEMORY", "AGE"], rows))
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

	const lines = [
		`name:        ${workspace.alias}`,
		workspace.description ? `description: ${workspace.description}` : undefined,
		`status:      ${workspace.status}`,
		workspace.uri ? `uri:         ${workspace.uri}` : undefined,
		`created:     ${workspace.createdAt.toISOString()}`,
		`cpu:         ${formatMillicores(workspace.cpuMillicores)}`,
		`memory:      ${formatBytes(workspace.ramBytes)}`,
		`storage:     ${formatBytes(workspace.pvcSizeBytes)}`,
	].filter((line): line is string => line !== undefined)
	for (const line of lines) console.log(line)
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

// ---------------------------------------------------------------- shared

function serializeWorkspace(w: Workspace): Record<string, unknown> {
	return {
		id: w.id,
		alias: w.alias,
		...(w.description ? { description: w.description } : {}),
		status: w.status,
		...(w.uri ? { uri: w.uri } : {}),
		createdAt: w.createdAt.getTime() > 0 ? w.createdAt.toISOString() : undefined,
		resources: {
			cpuMillicores: w.cpuMillicores,
			ramBytes: w.ramBytes,
			pvcSizeBytes: w.pvcSizeBytes,
		},
	}
}
