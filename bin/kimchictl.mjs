#!/usr/bin/env node
// Thin bin entry for the published npm package. The real CLI is dist/cli.js
// (built by `prepack`); it self-executes on import and sets process.exitCode.
// A missing dist means this is a source checkout — tell the user to build.
try {
	await import("../dist/cli.js")
} catch (error) {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined
	if (code === "ERR_MODULE_NOT_FOUND") {
		console.error(
			"kimchictl: dist/cli.js not found — run `pnpm run build` (source checkout) or install a published version.",
		)
	} else {
		console.error(error instanceof Error ? error.message : String(error))
	}
	process.exitCode = 2
}
