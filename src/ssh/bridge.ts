import type { Readable, Writable } from "node:stream"
import { type RawData, WebSocket } from "ws"

/**
 * Binary WebSocket↔stdio bridge — the runtime behind the hidden
 * `kimchictl ssh proxy` command that the generated ssh_config references via
 * ProxyCommand. TS port of kap's internal/ssh/bridge.go.
 *
 * Exit semantics (mirroring kap): stdin EOF or a normal WS close end the
 * bridge without error; any other failure rejects with a descriptive error.
 * The proxy process is short-lived — it exits when the bridge resolves, so
 * dangling listeners cannot outlive it.
 *
 * Keepalive: sends a WebSocket ping every 30s and expects a pong within 60s.
 * Without this, load balancers and NAT gateways drop idle connections after
 * 60-90s — the classic cause of "random" SSH disconnects through a tunnel.
 * Tab completion, which bursts data after a period of idleness, is often
 * when users first notice the dead connection.
 */

/** Interval between keepalive pings. */
const PING_INTERVAL_MS = 30_000
/** Close the connection if no pong arrives within this window after a ping. */
const PONG_TIMEOUT_MS = 60_000

export class BridgeError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "BridgeError"
	}
}

export interface BridgeOptions {
	wsUrl: string
	token: string
	input?: Readable
	output?: Writable
	/** Injected WebSocket constructor (tests may pass a wrapped client). */
	_WebSocket?: typeof WebSocket
}

export async function bridgeStdioToWebSocket(options: BridgeOptions): Promise<void> {
	const WS = options._WebSocket ?? WebSocket
	const input = options.input ?? process.stdin
	const output = options.output ?? process.stdout

	let ws: InstanceType<typeof WebSocket>
	try {
		ws = new WS(options.wsUrl, {
			headers: { Authorization: `Bearer ${options.token}` },
		})
	} catch (err) {
		throw new BridgeError(`websocket dial ${options.wsUrl}: ${err instanceof Error ? err.message : String(err)}`)
	}

	await new Promise<void>((resolve, reject) => {
		let settled = false
		const done = (err?: Error) => {
			if (settled) return
			settled = true
			if (err) reject(err)
			else resolve()
		}

		ws.on("open", () => done())
		ws.on("unexpected-response", (_req, res) => {
			done(
				new BridgeError(
					`websocket dial ${options.wsUrl}: unexpected HTTP ${res.statusCode} ${res.statusMessage ?? ""}`.trim(),
				),
			)
		})
		ws.on("error", (err) => done(new BridgeError(`websocket dial ${options.wsUrl}: ${err.message}`)))
	})

	return new Promise<void>((resolve, reject) => {
		let settled = false
		let pingTimer: ReturnType<typeof setInterval> | undefined
		let pongTimer: ReturnType<typeof setTimeout> | undefined

		const stopTimers = () => {
			if (pingTimer) clearInterval(pingTimer)
			if (pongTimer) clearTimeout(pongTimer)
			pingTimer = undefined
			pongTimer = undefined
		}

		const finish = (err?: Error) => {
			if (settled) return
			settled = true
			stopTimers()
			input.removeAllListeners()
			// Output is process.stdout when bridging for real — never end() that;
			// only close streams the caller explicitly passed in.
			if (options.output) output.end()
			if (err) reject(err)
			else resolve()
		}

		// Keepalive: ping every 30s; if no pong within 60s, the connection is
		// dead — close it so the SSH client can surface the failure instead of
		// hanging on a half-open socket.
		pingTimer = setInterval(() => {
			if (ws.readyState !== WebSocket.OPEN) return
			try {
				ws.ping()
			} catch {
				// ping() on a closing socket — the close handler takes over.
				return
			}
			if (pongTimer) clearTimeout(pongTimer)
			pongTimer = setTimeout(() => {
				finish(new BridgeError("websocket keepalive timeout — no pong received within 60s"))
			}, PONG_TIMEOUT_MS)
		}, PING_INTERVAL_MS)

		// Pong received — clear the timeout.
		ws.on("pong", () => {
			if (pongTimer) {
				clearTimeout(pongTimer)
				pongTimer = undefined
			}
		})

		// WS → stdout
		ws.on("message", (data: RawData, isBinary: boolean) => {
			// The workspace bridge is binary-only; text frames would be a server bug,
			// but writing them through is still friendlier than dropping bytes.
			void isBinary
			const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
			if (!output.write(buffer)) {
				// Keep memory bounded if the consumer stalls: pause the socket until drained.
				ws.pause()
				output.once("drain", () => ws.resume())
			}
		})
		ws.on("close", (code: number, reason: Buffer) => {
			stopTimers()
			// 1000 = normal closure; 1001 = going away (server restart/redeploy);
			// 1005 = no status code received (common with LB-induced disconnects).
			// All three end the bridge cleanly — SSH reconnects on the next command.
			if (code === 1000 || code === 1001 || code === 1005) {
				finish()
			} else {
				finish(new BridgeError(`websocket closed: ${code} ${reason.toString("utf-8") || "(no reason)"}`))
			}
		})
		ws.on("error", (err: Error & { code?: number }) =>
			finish(
				err.code === 1000 || err.code === 1001
					? undefined // normal / going-away closure
					: new BridgeError(`websocket error: ${err.message}`),
			),
		)

		// stdin → WS
		if (input.isPaused?.()) input.resume()
		input.on("data", (chunk: Buffer | string) => {
			if (ws.readyState !== WebSocket.OPEN) return
			// Send with a callback: a failed send (e.g., the connection dropped
			// between the readyState check and the actual write) surfaces as a
			// BridgeError instead of a silent data loss.
			ws.send(chunk, { binary: true }, (err) => {
				if (err && !settled) {
					finish(new BridgeError(`websocket send failed: ${err.message}`))
				}
			})
		})
		input.on("end", () => {
			stopTimers()
			if (ws.readyState === WebSocket.OPEN) ws.close(1000)
		})
		input.on("error", (err) => finish(err))
	})
}
