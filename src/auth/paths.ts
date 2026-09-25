import { homedir } from "node:os"
import { resolve } from "node:path"

/**
 * Shared-credential paths, mirroring kimchi-dev exactly:
 *
 *   ~/.config/kimchi/harness/     agent dir — auth.json, models.json
 *                                 (overridable via KIMCHI_CODING_AGENT_DIR,
 *                                  same fallback as kimchi-dev:src/cli.ts)
 *   ~/.config/kimchi/config.json  shared wizard config — the `apiKey` slot
 *                                 (fixed path, no env override — same as
 *                                  kimchi-dev:src/config.ts KIMCHI_CONFIG_PATH)
 */
export function resolveKimchiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.KIMCHI_CODING_AGENT_DIR ?? resolve(env.HOME ?? homedir(), ".config", "kimchi", "harness")
}

export function resolveAuthJsonPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(resolveKimchiAgentDir(env), "auth.json")
}

export function resolveModelsJsonPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(resolveKimchiAgentDir(env), "models.json")
}

export function resolveConfigJsonPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env.HOME ?? homedir(), ".config", "kimchi", "config.json")
}
