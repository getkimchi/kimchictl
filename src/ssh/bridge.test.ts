import type { AddressInfo } from "node:net"
import { Readable, Writable } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
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
