import { EventEmitter } from "node:events"
import type { AddressInfo } from "node:net"
import { PassThrough, Readable, Writable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocketServer } from "ws"
import { BridgeError, bridgeStdioToWebSocket } from "./bridge.js"

const servers: WebSocketServer[] = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

/** Start an echo+header-capture WS server. Returns the ws:// URL and captured state. */
async function startEchoServer(): Promise<{ url: string; authHeader: { value?: string } }> {
	const wss = new WebSocketServer({ port: 0 })
	servers.push(wss)
	const authHeader: { value?: string } = {}
	wss.on("connection", (ws, req) => {
		authHeader.value = req.headers.authorization
		ws.binaryType = "arraybuffer"
		ws.on("message", (data, isBinary) => {
			ws.send(data, { binary: isBinary })
		})
	})
	await new Promise<void>((resolve) => wss.on("listening", resolve))
	const { port } = wss.address() as AddressInfo
	return { url: `ws://127.0.0.1:${port}/ssh`, authHeader }
}

function collectOutput(): { output: Writable; chunks: Buffer[] } {
	const chunks: Buffer[] = []
	const output = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(Buffer.from(chunk))
			callback()
		},
	})
	return { output, chunks }
}

describe("bridgeStdioToWebSocket", () => {
	it("pumps stdin chunks through the WS and echoes them back to stdout", async () => {
		const { url, authHeader } = await startEchoServer()
		const { output, chunks } = collectOutput()

		await bridgeStdioToWebSocket({
			wsUrl: url,
			token: "workspace-jwt",
			input: Readable.from([Buffer.from("hello "), Buffer.from([0x00, 0xff, 0x42])]),
			output,
		})

		expect(authHeader.value).toBe("Bearer workspace-jwt")
		expect(Buffer.concat(chunks).toString("hex")).toBe(
			Buffer.concat([Buffer.from("hello "), Buffer.from([0x00, 0xff, 0x42])]).toString("hex"),
		)
	})

	it("queues at most one drain waiter under sustained output backpressure", async () => {
		// Reproduces the MaxListenersExceededWarning seen on disconnect: output
		// (the ProxyCommand's stdout) stalls when the SSH client stops reading,
		// every already-queued WS message then writes into a backpressured
		// stream, and each write must NOT add its own once("drain") waiter.
		class StalledOutput extends EventEmitter {
			ended = false
			write(): boolean {
				return false // always backpressured; never drains on its own
			}
			end(): this {
				this.ended = true
				return this
			}
		}

		let instance!: FakeWebSocket
		class FakeWebSocket extends EventEmitter {
			readyState = 1 // OPEN
			pauses = 0
			resumes = 0
			burstSent: Promise<void>
			private markBurstSent!: () => void
			constructor() {
				super()
				instance = this
				this.burstSent = new Promise((resolve) => (this.markBurstSent = resolve))
				setImmediate(() => {
					this.emit("open")
					// Fire the burst after the bridge has fully switched to its
					// message-pumping handlers (registered right after `open`).
					setTimeout(() => {
						for (let i = 0; i < 32; i++) this.emit("message", Buffer.alloc(8), true)
						this.markBurstSent()
					}, 10)
				})
			}
			send(_data: unknown, _opts: unknown, cb?: (err?: Error) => void): void {
				cb?.()
			}
			pause(): void {
				this.pauses++
			}
			resume(): void {
				this.resumes++
			}
			ping(): void {}
			close(code?: number): void {
				this.emit("close", code ?? 1000, Buffer.alloc(0))
			}
			terminate(): void {}
		}

		const warnings: string[] = []
		const onWarning = (warning: Error) => {
			if (warning.name === "MaxListenersExceededWarning") warnings.push(warning.message)
		}
		process.on("warning", onWarning)
		try {
			const output = new StalledOutput()
			const bridge = bridgeStdioToWebSocket({
				wsUrl: "ws://127.0.0.1:0/fake",
				token: "t",
				input: new PassThrough(), // never ends — avoids the half-close path racing the burst
				output: output as unknown as Writable,
				_WebSocket: FakeWebSocket as never,
			})

			await instance.burstSent
			await vi.waitFor(() => expect(instance.pauses).toBeGreaterThan(0))

			// The exact user-facing symptom pre-fix: 11+ drain listeners and a warning.
			expect(warnings).toEqual([])
			expect(output.listenerCount("drain")).toBeLessThanOrEqual(1)

			// The single waiter must still resume the socket when the stream drains.
			output.emit("drain")
			expect(instance.resumes).toBe(1)

			instance.close()
			await bridge
			expect(output.ended).toBe(true)
		} finally {
			process.removeListener("warning", onWarning)
		}
	})

	it("fails to start with a BridgeError when the endpoint rejects the handshake", async () => {
		// No server listening on this port.
		await expect(
			bridgeStdioToWebSocket({
				wsUrl: "ws://127.0.0.1:1/ssh",
				token: "t",
				input: Readable.from([]),
				output: collectOutput().output,
			}),
		).rejects.toThrow(BridgeError)
	})
})
