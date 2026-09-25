import { readFileSync, statSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanupTempDirs, makeTempDir } from "../test-support.js"
import {
	isSshIntegrationConfigured,
	resolveProxyCommandTarget,
	resolveSshDomain,
	SSH_INCLUDE_BEGIN,
	type SshPaths,
	setupSshIntegration,
	sshConfigContent,
	uninstallSshIntegration,
} from "./config.js"

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
})

function makePaths(): { root: string; paths: SshPaths } {
	const root = makeTempDir()
	return {
		root,
		paths: {
			home: join(root, ".kimchictl"),
			sshConfig: join(root, ".kimchictl", "ssh_config"),
			knownHosts: join(root, ".kimchictl", "known_hosts"),
			userSshConfig: join(root, ".ssh", "config"),
		},
	}
}

const DOMAIN = "remote.kimchi.dev"

describe("setupSshIntegration", () => {
	it("writes ssh_config (0600) and prepends the Include block", async () => {
		const { paths } = makePaths()

		const { notes } = await setupSshIntegration({ paths, domain: DOMAIN })

		const generated = readFileSync(paths.sshConfig, "utf-8")
		expect(generated).toBe(sshConfigContent(DOMAIN, paths.knownHosts, "kimchictl"))
		expect(statSync(paths.sshConfig).mode & 0o777).toBe(0o600)

		const userConfig = readFileSync(paths.userSshConfig, "utf-8")
		expect(userConfig).toBe(`${SSH_INCLUDE_BEGIN}\nInclude ${paths.sshConfig}\n# <<< kimchictl managed include <<<\n`)
		expect(notes).toEqual([
			`wrote ${paths.sshConfig} (Host *.${DOMAIN})`,
			`added Include block to ${paths.userSshConfig}`,
		])
	})

	it("keeps the Include above existing user Host blocks (first match wins)", async () => {
		const { paths } = makePaths()
		await mkdir(join(paths.userSshConfig, ".."), { recursive: true })
		writeFileSync(paths.userSshConfig, "Host example\n    HostName example.com\n")

		await setupSshIntegration({ paths, domain: DOMAIN })

		const userConfig = readFileSync(paths.userSshConfig, "utf-8")
		expect(userConfig.startsWith(SSH_INCLUDE_BEGIN)).toBe(true)
		expect(userConfig).toContain("Host example\n    HostName example.com\n")
	})

	it("is idempotent (second run produces no notes, no duplicate block)", async () => {
		const { paths } = makePaths()

		await setupSshIntegration({ paths, domain: DOMAIN })
		const { notes } = await setupSshIntegration({ paths, domain: DOMAIN })

		expect(notes).toEqual([])
		const userConfig = readFileSync(paths.userSshConfig, "utf-8")
		expect(userConfig.split(SSH_INCLUDE_BEGIN).length - 1).toBe(1)
	})

	it("replaces a stale managed block pointing at a different path", async () => {
		const { paths } = makePaths()
		await setupSshIntegration({ paths, domain: DOMAIN })

		const moved = { ...paths, home: join(paths.home, "moved"), sshConfig: join(paths.home, "moved", "ssh_config") }
		const { notes } = await setupSshIntegration({ paths: moved, domain: DOMAIN })

		const userConfig = readFileSync(paths.userSshConfig, "utf-8")
		expect(userConfig).toContain(`Include ${moved.sshConfig}`)
		expect(userConfig).not.toContain(`Include ${paths.sshConfig}`)
		expect(notes).toContain(`updated stale Include block in ${paths.userSshConfig}`)
	})

	it("warns about a conflicting kap-managed block", async () => {
		const { paths } = makePaths()
		await mkdir(join(paths.userSshConfig, ".."), { recursive: true })
		writeFileSync(
			paths.userSshConfig,
			"# >>> kap managed include >>>\nInclude /home/x/.config/kap/ssh_config\n# <<< kap managed include <<<\n",
		)

		const { notes } = await setupSshIntegration({ paths, domain: DOMAIN })

		expect(notes.some((n) => n.includes("kap-managed"))).toBe(true)
	})
})

describe("uninstallSshIntegration", () => {
	it("removes the block and the generated ssh_config, keeping other content", async () => {
		const { paths } = makePaths()
		await mkdir(join(paths.userSshConfig, ".."), { recursive: true })
		writeFileSync(paths.userSshConfig, "Host example\n    HostName example.com\n")
		await setupSshIntegration({ paths, domain: DOMAIN })

		const { notes } = await uninstallSshIntegration({ paths })

		const userConfig = readFileSync(paths.userSshConfig, "utf-8")
		expect(userConfig).not.toContain("kimchictl managed include")
		expect(userConfig).toContain("Host example")
		expect(notes).toEqual([`removed Include block from ${paths.userSshConfig}`, `removed ${paths.sshConfig}`])
	})

	it("is a no-op when nothing was configured", async () => {
		const { paths } = makePaths()
		const { notes } = await uninstallSshIntegration({ paths })
		expect(notes).toEqual([])
	})
})

describe("isSshIntegrationConfigured", () => {
	it("false before setup, true after, false again on domain drift", async () => {
		const { paths } = makePaths()

		expect(await isSshIntegrationConfigured(paths, DOMAIN)).toBe(false)
		await setupSshIntegration({ paths, domain: DOMAIN })
		expect(await isSshIntegrationConfigured(paths, DOMAIN)).toBe(true)
		// Endpoint changed → different wildcard domain → re-setup needed.
		expect(await isSshIntegrationConfigured(paths, "remote.dev.example.com")).toBe(false)
	})
})

describe("resolveSshDomain", () => {
	it("defaults to remote.kimchi.dev", () => {
		vi.stubEnv("KIMCHI_REMOTE_ENDPOINT", "")
		vi.stubEnv("KIMCHICTL_SSH_DOMAIN", "")
		expect(resolveSshDomain()).toBe("remote.kimchi.dev")
	})

	it("derives from an endpoint override (app.X → remote.X)", () => {
		expect(
			resolveSshDomain(undefined, { KIMCHI_REMOTE_ENDPOINT: "https://app.dev.kimchi.dev/api" } as NodeJS.ProcessEnv),
		).toBe("remote.dev.kimchi.dev")
	})

	it("honors explicit flag and env override before derivation", () => {
		expect(
			resolveSshDomain("custom.example", {
				KIMCHI_REMOTE_ENDPOINT: "https://app.dev.kimchi.dev/api",
			} as NodeJS.ProcessEnv),
		).toBe("custom.example")
		expect(resolveSshDomain(undefined, { KIMCHICTL_SSH_DOMAIN: "env.example" } as NodeJS.ProcessEnv)).toBe(
			"env.example",
		)
	})
})

describe("resolveProxyCommandTarget", () => {
	it("uses the compiled binary path when named like kimchictl", () => {
		expect(resolveProxyCommandTarget("/usr/local/bin/kimchictl")).toBe("/usr/local/bin/kimchictl")
		expect(resolveProxyCommandTarget("/opt/kimchictl-v1.2.3")).toBe("/opt/kimchictl-v1.2.3")
	})

	it("falls back to PATH lookup under a node/bun runtime", () => {
		expect(resolveProxyCommandTarget("/usr/local/bin/node")).toBe("kimchictl")
	})
})
