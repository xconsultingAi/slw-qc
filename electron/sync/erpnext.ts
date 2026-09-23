/**
 * HTTP client for `slw.api.qc_desktop`.
 *
 * Authenticates with a Frappe API key pair rather than a session cookie. A password
 * session expires and cannot be renewed unattended, which would strand a station whose
 * operator has gone home mid-queue; a key pair survives restarts.
 *
 * `ErpNetworkError` is separated from every other failure deliberately. A transport
 * failure means the server may or may not have committed, so the push loop retries it
 * without consuming an attempt. Anything else is a real answer and counts.
 */

export class ErpNetworkError extends Error {
	override readonly name = "ErpNetworkError";
}

export class ErpAuthError extends Error {
	override readonly name = "ErpAuthError";
}

export interface ErpConfig {
	baseUrl: string;
	apiKey: string;
	apiSecret: string;
}

export const API_VERSION = 1;

/** Per-endpoint, because a cold master pull is not a failed ping. */
const TIMEOUTS = { ping: 8_000, pull: 120_000, push: 120_000, default: 30_000 };

export interface SessionBootstrap {
	user: string;
	full_name: string;
	roles: string[];
	api_key: string;
	api_secret: string;
	api_version: number;
}

export interface PushResultRow {
	offline_uuid: string | null;
	ok: boolean;
	name?: string;
	docstatus?: number;
	inward_no?: string | null;
	grn_type?: string | null;
	inward_status?: string | null;
	error?: string;
}

function joinUrl(baseUrl: string, path: string): string {
	return baseUrl.replace(/\/+$/, "") + path;
}

/**
 * Frappe wraps whitelisted returns in `{"message": ...}` and reports errors as an HTML
 * `exc` payload. Unwrapping in one place keeps every caller from re-learning that.
 */
async function readBody(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return null;
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		return "message" in parsed ? parsed.message : parsed;
	} catch {
		return text;
	}
}

function extractError(body: unknown, status: number): string {
	if (typeof body === "string") return stripHtml(body) || `HTTP ${status}`;
	if (body && typeof body === "object") {
		const record = body as Record<string, unknown>;
		const raw = record._server_messages ?? record.exception ?? record.message ?? record.exc;
		if (typeof raw === "string") {
			// _server_messages is a JSON array of JSON strings; the useful text is inside.
			try {
				const messages = JSON.parse(raw) as string[];
				const first = JSON.parse(messages[0] ?? "{}") as { message?: string };
				if (first.message) return stripHtml(first.message);
			} catch {
				return stripHtml(raw);
			}
			return stripHtml(raw);
		}
	}
	return `HTTP ${status}`;
}

function stripHtml(value: string): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export class ErpnextClient {
	constructor(private config: ErpConfig) {}

	setConfig(config: ErpConfig): void {
		this.config = config;
	}

	private async call<T>(method: string, timeoutMs: number, args: Record<string, unknown>): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		let response: Response;
		try {
			response = await fetch(joinUrl(this.config.baseUrl, `/api/method/slw.api.qc_desktop.${method}`), {
				method: "POST",
				headers: {
					Authorization: `token ${this.config.apiKey}:${this.config.apiSecret}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({ ...args, client_version: API_VERSION }),
				signal: controller.signal,
			});
		} catch (error) {
			// DNS failure, refused connection, abort: the station is offline, not rejected.
			throw new ErpNetworkError((error as Error).message || "Could not reach the server.");
		} finally {
			clearTimeout(timer);
		}

		const body = await readBody(response);

		if (response.status === 401 || response.status === 403) {
			throw new ErpAuthError(extractError(body, response.status));
		}
		if (response.status >= 500) {
			// A 5xx is the server failing to answer, not answering "no": retry it.
			throw new ErpNetworkError(extractError(body, response.status));
		}
		if (!response.ok) {
			throw new Error(extractError(body, response.status));
		}

		return body as T;
	}

	ping() {
		return this.call<{ ok: boolean; user: string; api_version: number }>("ping", TIMEOUTS.ping, {});
	}

	sessionBootstrap() {
		return this.call<SessionBootstrap>("session_bootstrap", TIMEOUTS.default, {});
	}

	pull(cursors: Record<string, { modified: string; name: string }>) {
		return this.call<import("../db/repositories/masters").PullResult>("pull", TIMEOUTS.pull, {
			cursors: JSON.stringify(cursors),
		});
	}

	push(docs: unknown[]) {
		return this.call<{ results: PushResultRow[] }>("push", TIMEOUTS.push, {
			docs: JSON.stringify(docs),
		});
	}

	updateInwardQty(inwardNo: string, addless: number, grnType: string = "Inward Raw Hide") {
		return this.call<{ no_pieces: number; total_qty: number }>("update_inward_qty", TIMEOUTS.default, {
			inward_no: inwardNo,
			addless,
			grn_type: grnType,
		});
	}
}

/**
 * Sign in with a password, once, to obtain the key pair.
 *
 * Frappe's `/api/method/login` sets a session cookie; the very next call uses it to
 * fetch the caller's own API key and secret, after which the cookie is irrelevant and
 * the station authenticates with the pair alone.
 */
export async function loginForKeys(
	baseUrl: string,
	username: string,
	password: string
): Promise<SessionBootstrap> {
	let response: Response;
	try {
		response = await fetch(joinUrl(baseUrl, "/api/method/login"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ usr: username, pwd: password }),
		});
	} catch (error) {
		throw new ErpNetworkError((error as Error).message || "Could not reach the server.");
	}

	if (!response.ok) {
		throw new ErpAuthError(extractError(await readBody(response), response.status));
	}

	const cookie = response.headers.get("set-cookie");
	if (!cookie) throw new ErpAuthError("Server did not return a session.");

	let bootstrap: Response;
	try {
		bootstrap = await fetch(joinUrl(baseUrl, "/api/method/slw.api.qc_desktop.session_bootstrap"), {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ client_version: API_VERSION }),
		});
	} catch (error) {
		throw new ErpNetworkError((error as Error).message || "Could not reach the server.");
	}

	const body = await readBody(bootstrap);
	if (!bootstrap.ok) throw new ErpAuthError(extractError(body, bootstrap.status));

	return body as SessionBootstrap;
}
