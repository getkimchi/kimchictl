import { fetchWithTimeout } from "../api/http.js"
import { defaultInstallMethod, type InstallMethod, platformAssetName, selfUpdateToVersion } from "../updates/self.js"
import { VERSION } from "../version.js"
import { parseFlags, UsageError } from "./flags.js"

export interface UpdateDeps {
	fetch?: typeof globalThis.fetch
	env?: NodeJS.ProcessEnv
	/** Injection seams (tests). */
	installMethod?: InstallMethod
	download?: (url: string, destPath: string) => Promise<void>
	targetPath?: string
	currentVersion?: string
}

const LATEST_RELEASE_URL = "https://api.github.com/repos/getkimchi/kimchictl/releases/latest"

async function fetchLatestVersion(fetchImpl: typeof globalThis.fetch): Promise<string | undefined> {
	const resp = await fetchWithTimeout(
		LATEST_RELEASE_URL,
		{ headers: { "User-Agent": `kimchictl/${VERSION}` } },
		fetchImpl,
		15_000,
	)
	if (!resp.ok) return undefined
	const data = (await resp.json()) as { tag_name?: string }
	return typeof data.tag_name === "string" ? data.tag_name.replace(/^v/, "") : undefined
}

/**
 * `kimchictl update` — self-updates binary installs in place, tells brew/npm
 * users the command their package manager owns.
 */
export async function runUpdate(args: string[], deps: UpdateDeps = {}): Promise<number> {
	const { positionals } = parseFlags("update", args, {})
	if (positionals.length > 0) {
		throw new UsageError("kimchictl update: unexpected positional argument")
	}

	const method = deps.installMethod ?? defaultInstallMethod()

	if (method === "homebrew") {
		console.log("kimchictl was installed via Homebrew — update with:")
		console.log("")
		console.log("  brew upgrade kimchictl")
		return 0
	}
	if (method === "runtime") {
		console.log("This kimchictl runs under a JS runtime (npm install or dev checkout) — update with:")
		console.log("")
		console.log("  npm update -g kimchictl     # npm users")
		console.log("  git pull && pnpm install    # source checkouts")
		return 0
	}

	const current = deps.currentVersion ?? VERSION
	if (current.endsWith("-dev")) {
		console.log("Dev build — self-update only works for released binaries.")
		return 0
	}

	const fetchImpl = deps.fetch ?? globalThis.fetch
	const latest = await fetchLatestVersion(fetchImpl)
	if (latest === undefined) {
		console.error("✗ could not determine the latest release (GitHub API unavailable)")
		return 1
	}
	if (latest === current) {
		console.log(`kimchictl ${current} — already up to date.`)
		return 0
	}

	const targetPath = deps.targetPath ?? process.execPath
	console.log(`updating kimchictl ${current} → ${latest} (${platformAssetName()})…`)
	await selfUpdateToVersion({ targetPath, version: latest, fetch: fetchImpl, download: deps.download })
	console.log(`✓ kimchictl ${latest} installed at ${targetPath}`)
	return 0
}
