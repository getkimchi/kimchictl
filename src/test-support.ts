/**
 * Shared test helpers — co-located *.test.ts files import from here instead of
 * re-rolling temp-dir / fetch-stub / console-capture boilerplate per file.
 * Excluded from the published build (tsconfig.build.json).
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { vi } from "vitest"

const tempDirs: string[] = []

export function makeTempDir(prefix = "kimchictl-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix))
	tempDirs.push(dir)
	return dir
}

/** Call from afterEach — removes every dir created via makeTempDir. */
export function cleanupTempDirs(): void {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export type FetchImpl = typeof globalThis.fetch

/**
 * Build a fetch stub from a narrow implementation. The `as unknown` adapts the
 * test's string-URL signature to fetch's wide `(string | URL | Request)` one —
 * deliberate, one place, test-only.
 */
export function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): FetchImpl {
	return impl as unknown as FetchImpl
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	})
}

/** Point the shared-credential paths at a temp dir and neutralize ambient key env vars. */
export function stubAgentDirEnv(dir: string): void {
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", dir)
	// resolveApiKey treats an empty KIMCHI_API_KEY as absent.
	vi.stubEnv("KIMCHI_API_KEY", "")
}

/** Capture console.log / console.error; restore() in afterEach (or rely on vi.restoreAllMocks). */
export function captureConsole(): { lines: string[]; errors: string[] } {
	const lines: string[] = []
	const errors: string[] = []
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(" "))
	})
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args.map(String).join(" "))
	})
	return { lines, errors }
}
