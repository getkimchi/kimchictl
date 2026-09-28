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

		ws.on("open", () => {
			if (process.env.KIMCHICTL_DEBUG) {
				process.stderr.write("[bridge] ws open\n")
			}
			done()
		})
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

		// Total-inactivity watchdog: if no data flows in either direction for
		// 10 seconds, terminate. This catches the deadlock where the SSH client
		// has finished (sent disconnect through the data stream) but keeps the
		// ProxyCommand's stdin pipe open — the bridge would otherwise wait forever
		// for a WebSocket close that the server never sends. Interactive sessions
		// are unaffected: user keystrokes and remote output reset the timer, and
		// the keepalive pings show as pong activity on the WebSocket.
		let watchdog: ReturnType<typeof setTimeout> | undefined
		const resetWatchdog = () => {
			if (watchdog) clearTimeout(watchdog)
			watchdog = setTimeout(() => {
				if (!settled) {
					if (process.env.KIMCHICTL_DEBUG) {
						process.stderr.write("[bridge] inactivity timeout — terminating\n")
					}
					ws.terminate()
				}
			}, 10_000)
		}
		resetWatchdog()

		const finish = (err?: Error) => {
			if (settled) return
			settled = true
			stopTimers()
			if (watchdog) clearTimeout(watchdog)
			input.removeAllListeners()
			if (input === process.stdin) {
				process.stdin.unref()
			}
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
			resetWatchdog()
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
			// Always log unexpected disconnects to stderr — this is the primary
			// diagnostic for "random disconnect" reports. Normal closures (1000)
			// and our watchdog (1006) are silent; anything else tells us what the
			// server or network layer did.
			if (code !== 1000 && code !== 1006) {
				process.stderr.write(
					`kimchictl: websocket closed: code=${code} reason=${reason.toString("utf-8") || "(none)"}\n`,
				)
			}
			if (process.env.KIMCHICTL_DEBUG) {
				process.stderr.write(`[bridge] ws close: code=${code} reason=${reason.toString("utf-8")}\n`)
			}
			stopTimers()
			// 1000 = normal closure; 1001 = going away (server restart);
			// 1005 = no status code (common with LB-induced disconnects);
			// 1006 = abnormal closure (our watchdog terminate, or server crash).
			// All four end the bridge — the SSH client reconnects on the next command.
			if (code === 1000 || code === 1001 || code === 1005 || code === 1006) {
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
			resetWatchdog()
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
			if (process.env.KIMCHICTL_DEBUG) {
				process.stderr.write("[bridge] stdin end — initiating half-close\n")
			}
			// Initiate a WebSocket half-close: tell the server we won't send more
			// data, but keep reading — the server still has output to flush.
			//
			// Grace period: if the server doesn't complete the close handshake
			// within 5 seconds (e.g., the remote process is still running and the
			// Go server won't close its side), terminate the socket to unblock
			// the SSH client. Without this, SSH and the bridge deadlock: SSH waits
			// for the ProxyCommand to exit, the bridge waits for the WebSocket
			// close, and the server waits for the remote process which is waiting
			// for an EOF that was already sent but lost in the close race.
			if (ws.readyState === WebSocket.OPEN) {
				ws.close(1000)
				const graceTimer = setTimeout(() => {
					if (ws.readyState !== WebSocket.CLOSED) {
						if (process.env.KIMCHICTL_DEBUG) {
							process.stderr.write("[bridge] close handshake timeout — terminating\n")
						}
						ws.terminate()
					}
				}, 5_000)
				// Clear the grace timer if the close completes normally.
				ws.once("close", () => clearTimeout(graceTimer))
			}
		})
		input.on("error", (err) => finish(err))
	})
}
