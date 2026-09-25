import { run } from "./run.js"

// Executable CLI target: `bun build --compile src/cli.ts`, `bun run dev`,
// and the published dist/cli.js behind bin/kimchictl.mjs. Self-executes on
// import; never imported as a library (run.ts is the library surface).
process.exitCode = await run(process.argv.slice(2))
