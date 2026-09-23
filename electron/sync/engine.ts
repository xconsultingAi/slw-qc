/**
 * Sync loop: pulls masters, pushes confirmed checklists.
 *
 * Both timers reschedule themselves with jitter and start at a random offset, so a
 * floor full of stations that all boot when the shift starts does not hit the server in
 * lockstep.
 *
 * The loop never blocks the operator. Pulling and pushing happen entirely behind the
 * grid; a station with no network keeps taking measurements and simply accumulates
 * queued checklists.
 */
import type { Db } from "../db/connection";
import { applyServerConfirmation } from "../db/repositories/checklists";
import {
	dueForPush,
	markConfirmed,
	markFailed,
	markSent,
	releaseInFlight,
	queueCounts,
} from "../db/repositories/outbox";
import { applyPullResult, readCursors } from "../db/repositories/masters";
import { ErpAuthError, ErpNetworkError, type ErpnextClient } from "./erpnext";

const PULL_INTERVAL_MS = 60_000;
const PUSH_INTERVAL_MS = 20_000;
const PUSH_BATCH = 20;

/** +/- 15%, so independent stations drift apart instead of synchronising. */
function jitter(baseMs: number): number {
	return Math.round(baseMs * (0.85 + Math.random() * 0.3));
}

export interface SyncStatus {
	online: boolean;
	lastPullAt: string | null;
	lastPushAt: string | null;
	lastError: string | null;
	queue: ReturnType<typeof queueCounts>;
}

export interface SyncEngineOptions {
	db: Db;
	client: ErpnextClient;
	onStatus?: (status: SyncStatus) => void;
	/** Raised when credentials stop working, so the UI can ask for a fresh sign-in. */
	onAuthError?: (message: string) => void;
}

export class SyncEngine {
	private timers = new Map<string, NodeJS.Timeout>();
	private stopped = true;
	private running = new Set<string>();
	private status: SyncStatus;

	constructor(private options: SyncEngineOptions) {
		this.status = {
			online: false,
			lastPullAt: null,
			lastPushAt: null,
			lastError: null,
			queue: queueCounts(options.db),
		};
	}

	getStatus(): SyncStatus {
		return { ...this.status, queue: queueCounts(this.options.db) };
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.loop("pull", PULL_INTERVAL_MS, () => this.pullOnce());
		this.loop("push", PUSH_INTERVAL_MS, () => this.pushOnce());
	}

	stop(): void {
		this.stopped = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	private loop(label: string, baseMs: number, tick: () => Promise<void>): void {
		const run = async () => {
			try {
				await tick();
			} catch (error) {
				this.note(error as Error);
			} finally {
				if (!this.stopped) this.timers.set(label, setTimeout(run, jitter(baseMs)));
			}
		};
		// A random first delay so simultaneous boots do not become a thundering herd.
		this.timers.set(label, setTimeout(run, Math.round(Math.random() * baseMs)));
	}

	private note(error: Error): void {
		if (error instanceof ErpNetworkError) {
			this.status.online = false;
			this.status.lastError = error.message;
		} else if (error instanceof ErpAuthError) {
			this.status.online = true;
			this.status.lastError = error.message;
			this.options.onAuthError?.(error.message);
		} else {
			this.status.lastError = error.message;
		}
		this.emit();
	}

	private emit(): void {
		this.options.onStatus?.(this.getStatus());
	}

	/** Guard against a slow tick overlapping the next one on the same channel. */
	private async exclusive(label: string, fn: () => Promise<void>): Promise<void> {
		if (this.running.has(label)) return;
		this.running.add(label);
		try {
			await fn();
		} finally {
			this.running.delete(label);
		}
	}

	async pullOnce(): Promise<void> {
		await this.exclusive("pull", async () => {
			const { db, client } = this.options;

			// Follow-on rounds while the server says there is more, so a cold start
			// completes without waiting a full interval per page.
			for (let round = 0; round < 20; round++) {
				const result = await client.pull(readCursors(db));
				applyPullResult(db, result);

				this.status.online = true;
				this.status.lastPullAt = new Date().toISOString();
				this.status.lastError = null;

				if (!Object.values(result.doctypes).some((payload) => payload.has_more)) break;
			}

			this.emit();
		});
	}

	async pushOnce(): Promise<void> {
		await this.exclusive("push", async () => {
			const { db, client } = this.options;

			const batch = dueForPush(db, PUSH_BATCH);
			if (!batch.length) return;

			const uuids = batch.map((row) => row.offline_uuid);
			markSent(db, uuids);

			let response: Awaited<ReturnType<ErpnextClient["push"]>>;
			try {
				response = await client.push(batch.map((row) => JSON.parse(row.payload_json)));
			} catch (error) {
				// No answer at all: the server may have committed every one of these. Put
				// them back untouched and let the idempotent retry sort it out.
				releaseInFlight(db, uuids);
				throw error;
			}

			const answered = new Set<string>();
			for (const result of response.results ?? []) {
				if (!result.offline_uuid) continue;
				answered.add(result.offline_uuid);

				if (result.ok && result.name) {
					markConfirmed(db, result.offline_uuid, result.name);
					const grnType =
						result.grn_type === "Merge Inward Raw Hide" ? "Merge Inward Raw Hide" : "Inward Raw Hide";
					applyServerConfirmation(
						db,
						result.offline_uuid,
						result.name,
						result.inward_no ?? null,
						result.inward_status ?? null,
						grnType
					);
				} else {
					markFailed(db, result.offline_uuid, result.error ?? "Rejected without a reason.");
				}
			}

			// A row the server said nothing about was never decided; retry it rather than
			// leaving it stuck in 'sent' forever.
			releaseInFlight(
				db,
				uuids.filter((uuid) => !answered.has(uuid))
			);

			this.status.online = true;
			this.status.lastPushAt = new Date().toISOString();
			this.emit();
		});
	}
}
