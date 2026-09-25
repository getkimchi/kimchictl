import { resolveWorkspace } from "../api/resolver.js"
import { formatAge, formatBytes, formatMillicores } from "../api/resources.js"
import { resolveTemplate } from "../api/templates.js"
import { waitForWorkspaceActive } from "../api/wait.js"
import { createWorkspace, deleteWorkspace, listWorkspaces, type Workspace } from "../api/workspaces.js"
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
