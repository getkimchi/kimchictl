import { createHash } from "node:crypto"
import { chmod, mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fetchWithTimeout } from "../api/http.js"
import { VERSION } from "../version.js"

/**
 * Self-update plumbing: detect how kimchictl was installed and, for binary
 * installs, swap the executable in place from the latest GitHub release.
 * Homebrew/npm/RTE (runtime) installs delegate to their own updaters.
 */

export type InstallMethod = "binary" | "homebrew" | "runtime"

/** realpath seam: tests feed synthetic paths. */
export function detectInstallMethod(realpath: () => string): InstallMethod {
	const target = realpath()
	if (/\/(Cellar|linuxbrew)\/[^/]*kimchictl?\//.test(target) || /homebrew.*kimchictl/i.test(target)) {
		return "homebrew"
	}
	const base = basename(target)
	if (base === "node" || base === "bun" || base === "node.exe") {
		return "runtime"
	}
	return "binary"
}

/** realpath of the running executable, best-effort. */
export function defaultInstallMethod(execPath = process.execPath): InstallMethod {
	// bun-compiled binaries ARE the install (execPath is the binary); node/bun
	// runtime hosts are npm/dev installs.
	const base = basename(execPath)
	if (base === "node" || base === "bun" || base === "node.exe") return "runtime"
	return detectInstallMethod(() => execPath)
}

/** Release asset name for this platform, e.g. kimchictl-darwin-arm64. */
export function platformAssetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
	const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined
	const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined
	if (!os || !cpu) {
		throw new Error(`unsupported platform for self-update: ${platform}/${arch}`)
	}
	return `kimchictl-${os}-${cpu}`
}

export class SelfUpdateError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SelfUpdateError"
	}
}

/** Distinct from a checksums-download failure: a verified mismatch always aborts. */
export class ChecksumMismatchError extends SelfUpdateError {
	constructor(message: string) {
		super(message)
		this.name = "ChecksumMismatchError"
	}
}

export interface SelfUpdateOptions {
	targetPath: string
	version: string // e.g. "0.2.0" — bare tag (release.yml tags are bare)
	fetch?: typeof globalThis.fetch
	download?: (url: string, destPath: string) => Promise<void>
	chmodFn?: (path: string, mode: number) => Promise<void>
	renameFn?: (from: string, to: string) => Promise<void>
	tmpRoot?: string
}

async function defaultDownload(url: string, destPath: string): Promise<void> {
	const resp = await fetchWithTimeout(url, {}, globalThis.fetch, 60_000)
	if (!resp.ok) {
		throw new SelfUpdateError(`download failed: HTTP ${resp.status} for ${url}`)
	}
	await writeFile(destPath, new Uint8Array(await resp.arrayBuffer()))
}

/**
 * Download the release asset for the current platform, checksum-verify it
 * against release checksums.txt, then atomically rename it over targetPath.
 */
export async function selfUpdateToVersion(options: SelfUpdateOptions): Promise<void> {
	const base = `https://github.com/getkimchi/kimchictl/releases/download/${options.version}`
	const asset = platformAssetName()
	const download = options.download ?? defaultDownload
	const chmodFn = options.chmodFn ?? chmod
	const renameFn = options.renameFn ?? rename

	const tmpDir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "kimchictl-update-"))
	const staged = join(tmpDir, "kimchictl")

	await download(`${base}/${asset}`, staged)

	// Verify against the release checksums.txt when it exists.
	const checksumsPath = join(tmpDir, "checksums.txt")
	try {
		await download(`${base}/checksums.txt`, checksumsPath)
		const checksums = await readFile(checksumsPath, "utf-8")
		const expected = checksums
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.endsWith(` ${asset}`))
			?.split(/\s+/)[0]
		if (expected) {
			const actual = createHash("sha256")
				.update(await readFile(staged))
				.digest("hex")
			if (actual !== expected) {
				throw new ChecksumMismatchError(
					`checksum mismatch for ${asset} — aborting update (expected ${expected}, got ${actual})`,
				)
			}
		}
	} catch (err) {
		if (err instanceof ChecksumMismatchError) throw err
		// Fetching checksums.txt itself failed (older releases may lack it) — proceed without verification.
	}

	await chmodFn(staged, 0o755)
	await renameFn(staged, options.targetPath)
}

/** Guard for the update command — plain error for guard.ts, no new error family. */
export function assertNotDevBuild(): void {
	if (VERSION.endsWith("-dev")) {
		throw new SelfUpdateError("self-update is not available from a dev build (VERSION is 0.0.0-dev)")
	}
}
