import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import { cleanupTempDirs, makeTempDir } from "../test-support.js"
import { detectInstallMethod, platformAssetName, selfUpdateToVersion } from "./self.js"

afterEach(() => cleanupTempDirs())

describe("detectInstallMethod", () => {
	it("recognizes Homebrew, runtimes, and plain binaries", () => {
		expect(detectInstallMethod(() => "/opt/homebrew/Cellar/kimchictl/0.2.0/bin/kimchictl")).toBe("homebrew")
		expect(detectInstallMethod(() => "/usr/local/bin/node")).toBe("runtime")
		expect(detectInstallMethod(() => "/opt/homebrew/bin/bun")).toBe("runtime")
		expect(detectInstallMethod(() => "/usr/local/bin/kimchictl")).toBe("binary")
		expect(detectInstallMethod(() => "/home/u/.local/bin/kimchictl")).toBe("binary")
	})
})

describe("platformAssetName", () => {
	it("maps node platform/arch to release asset names", () => {
		expect(platformAssetName("darwin", "arm64")).toBe("kimchictl-darwin-arm64")
		expect(platformAssetName("linux", "x64")).toBe("kimchictl-linux-x64")
		expect(() => platformAssetName("win32" as NodeJS.Platform, "x64")).toThrow("unsupported platform")
	})
})

describe("selfUpdateToVersion", () => {
	function scenario(options?: { withChecksums?: boolean; tamper?: boolean }) {
		const tmp = makeTempDir()
		const binary = Buffer.from("#!/bin/fake kimchictl binary\n")
		const downloads = new Map<string, Buffer>()
		// Checksum of the PRISTINE bytes; tamper must corrupt the served binary only.
		if (options?.withChecksums !== false) {
			downloads.set(
				"checksums.txt",
				Buffer.from(
					`${createHash("sha256").update(binary).digest("hex")}  kimchictl-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}\n`,
				),
			)
		}
		if (options?.tamper) binary[0] = 0x21
		downloads.set("kimchictl-darwin-arm64", binary)
		downloads.set("kimchictl-linux-arm64", binary)
		downloads.set("kimchictl-darwin-x64", binary)
		downloads.set("kimchictl-linux-x64", binary)

		const written = new Map<string, Buffer>()
		const renamed: string[][] = []
		return {
			tmp,
			binary,
			// Real download writes to dest — selfUpdateToVersion re-reads the staged
			// file from disk when checksum-verifying.
			download: async (url: string, dest: string) => {
				const name = url.split("/").pop() ?? ""
				const bytes = downloads.get(name)
				if (!bytes) throw new Error(`404 ${name}`)
				written.set(dest, bytes)
				await writeFile(dest, bytes)
			},
			renamed,
			renameFn: async (from: string, to: string) => {
				renamed.push([from, to])
			},
			chmodFn: async () => {},
		}
	}

	it("downloads the platform asset, verifies the checksum, and renames over the target", async () => {
		const s = scenario()

		await selfUpdateToVersion({
			targetPath: "/usr/local/bin/kimchictl",
			version: "0.3.0",
			download: s.download,
			renameFn: s.renameFn,
			chmodFn: s.chmodFn,
			tmpRoot: s.tmp,
		})

		const stagedContent = [...s.renamed][0]
		expect(stagedContent?.[1]).toBe("/usr/local/bin/kimchictl")
		expect(stagedContent?.[0]).toContain("kimchictl-update-")
	})

	it("aborts on checksum mismatch", async () => {
		const s = scenario({ tamper: true })

		await expect(
			selfUpdateToVersion({
				targetPath: "/usr/local/bin/kimchictl",
				version: "0.3.0",
				download: s.download,
				renameFn: s.renameFn,
				chmodFn: s.chmodFn,
				tmpRoot: s.tmp,
			}),
		).rejects.toThrow(/checksum mismatch/)

		expect(s.renamed.length).toBe(0)
	})

	it("proceeds without verification when checksums.txt is absent (older releases)", async () => {
		const s = scenario({ withChecksums: false })

		await selfUpdateToVersion({
			targetPath: "/usr/local/bin/kimchictl",
			version: "0.3.0",
			download: s.download,
			renameFn: s.renameFn,
			chmodFn: s.chmodFn,
			tmpRoot: s.tmp,
		})

		expect(s.renamed.length).toBe(1)
	})
})
