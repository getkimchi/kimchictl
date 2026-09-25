import { getMe } from "../api/me.js"
import { requireApiKey } from "../auth/resolve.js"
import { parseFlags } from "./flags.js"

export interface WhoamiDeps {
	fetch?: typeof globalThis.fetch
	env?: NodeJS.ProcessEnv
}

/** `kimchictl whoami` — show the authenticated user (GET /v1/me). */
export async function runWhoami(args: string[], deps: WhoamiDeps = {}): Promise<number> {
	const { values } = parseFlags("whoami", args, {
		output: { type: "string", short: "o", default: "text" },
	})
	const env = deps.env ?? process.env

	const { key, source } = requireApiKey(env)
	const me = await getMe(key, { fetch: deps.fetch })

	if (values.output === "json") {
		console.log(JSON.stringify(me))
	} else {
		if (values.output !== "text") {
			console.error(`kimchictl whoami: unsupported --output "${values.output}" (expected text|json)`)
			return 2
		}
		console.log(`id:       ${me.id}`)
		if (me.username) console.log(`username: ${me.username}`)
		if (me.email) console.log(`email:    ${me.email}`)
		// Key source goes to stderr so stdout stays machine-parseable.
		console.error(
			`(authenticated via ${source === "environment" ? "KIMCHI_API_KEY" : source === "config" ? "config.json" : "auth.json"})`,
		)
	}
	return 0
}
