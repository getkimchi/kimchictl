import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fetchWithTimeout } from "../api/http.js"
import { resolveSshPaths } from "../ssh/config.js"
import { VERSION } from "../version.js"

/**
 * Daily background update check against the GitHub Releases API.
 *
 * The check must never block or fail a real command: every failure mode
 * resolves to "no notification". Results cache in
 * ~/.kimchictl/update-check.json for 24h.
 */

const LATEST_RELEASE_URL = "https://api.github.com/repos/getkimchi/kimchictl/releases/latest"
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 2500

interface UpdateCache {
	latestVersion: string
	checkedAt: string
}

/** Semantic-ish comparison: 0.10.0 > 0.9.9. Only digits matter; pre-releases compare numerically too. */
export function isNewer(latest: string, current: string): boolean {
	const parse = (v: string) =>
		v
			.replace(/^v/, "")
			.split(".")
			.map((part) => Number.parseInt(part, 10) || 0)
	const a = parse(latest)
	const b = parse(current)
	for (let i = 0; i < 3; i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0)
		if (diff !== 0) return diff > 0
	}
	return false
}

export interface UpdateCheckResult {
	latest: string
	current: string
}

async function readCache(path: string): Promise<UpdateCache | undefined> {
	try {
		const raw = JSON.parse(await readFile(path, "utf-8")) as Partial<UpdateCache>
		if (typeof raw.latestVersion === "string" && typeof raw.checkedAt === "string") {
			return { latestVersion: raw.latestVersion, checkedAt: raw.checkedAt }
		}
		return undefined
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined
		return undefined // corrupt cache → treat as stale (refetched below)
	}
}

async function writeCache(path: string, cache: UpdateCache): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 })
	await chmod(path, 0o600)
}

export interface CheckForUpdateOptions {
	env?: NodeJS.ProcessEnv
	fetch?: typeof globalThis.fetch
	now?: () => Date
	/** Version to compare against — tests inject; defaults to the baked-in VERSION. */
	currentVersion?: string
}

/** Returns {latest, current} when a newer release exists, otherwise undefined. Never throws. */
export async function checkForUpdate(options: CheckForUpdateOptions = {}): Promise<UpdateCheckResult | undefined> {
	try {
		const current = options.currentVersion ?? VERSION
		// Source checkouts and dev builds are not versioned against releases.
		if (current.endsWith("-dev")) return undefined

		const env = options.env ?? process.env
		if (env.KIMCHICTL_NO_UPDATE_CHECK) return undefined

		const now = options.now ?? (() => new Date())
		const cachePath = join(resolveSshPaths(env).home, "update-check.json")

		const cached = await readCache(cachePath)
		if (cached && now().getTime() - new Date(cached.checkedAt).getTime() < CHECK_INTERVAL_MS) {
			return isNewer(cached.latestVersion, current) ? { latest: cached.latestVersion, current } : undefined
		}

		const fetchImpl = options.fetch ?? globalThis.fetch
		const resp = await fetchWithTimeout(
			LATEST_RELEASE_URL,
			{ headers: { "User-Agent": `kimchictl/${current}` } },
			fetchImpl,
			FETCH_TIMEOUT_MS,
		)
		if (!resp.ok) return undefined
		const data = (await resp.json()) as { tag_name?: string }
		if (typeof data.tag_name !== "string") return undefined

		const latest = data.tag_name.replace(/^v/, "")
		await writeCache(cachePath, { latestVersion: latest, checkedAt: now().toISOString() }).catch(() => {
			// Cache writes are best-effort only.
		})
		return isNewer(latest, current) ? { latest, current } : undefined
	} catch {
		return undefined
	}
}

/** Post the update hint to stderr. Extracted so cli.ts stays a one-liner. */
export async function maybeNotifyUpdate(options: CheckForUpdateOptions = {}): Promise<void> {
	const result = await checkForUpdate(options)
	if (result) {
		console.error(`⬆ kimchictl ${result.latest} available (current ${result.current}) — update: kimchictl update`)
	}
}
