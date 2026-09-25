import { homedir } from "node:os"
import { resolve } from "node:path"

/**
 * The kimchi harness's agent dir is the single source of truth for shared
 * credentials. Resolution order mirrors the harness:
 * KIMCHI_CODING_AGENT_DIR env → ~/.config/kimchi-coding-agent.
 */
export function resolveKimchiAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.KIMCHI_CODING_AGENT_DIR ?? resolve(env.HOME ?? homedir(), ".config/kimchi-coding-agent")
}

export function resolveAuthJsonPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(resolveKimchiAgentDir(env), "auth.json")
}

export function resolveModelsJsonPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(resolveKimchiAgentDir(env), "models.json")
}

export function resolveConfigJsonPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(resolveKimchiAgentDir(env), "config.json")
}
