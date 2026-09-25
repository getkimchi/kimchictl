import { run } from "./run.js"
import { maybeNotifyUpdate } from "./updates/check.js"

// Executable CLI target: `bun build --compile src/cli.ts`, `bun run dev`,
// and the published dist/cli.js behind bin/kimchictl.mjs. Self-executes on
// import; never imported as a library (run.ts is the library surface).
const argv = process.argv.slice(2)
const code = await run(argv)

// Daily background update notice: prints to stderr, never fails the command.
// Skipped for `ssh` — its stdio belongs to the SSH session / proxy bridge,
// where any extra bytes would corrupt the stream.
if (argv[0] !== "ssh") {
	await maybeNotifyUpdate()
}
process.exitCode = code
