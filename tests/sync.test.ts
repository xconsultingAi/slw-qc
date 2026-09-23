/**
 * Sync engine behaviour, driven against a fake ERPNext client.
 *
 * The cases that matter are the failure ones. The difference between "the server said
 * no" and "the server never answered" decides whether a station backs off for minutes
 * or retries immediately, and whether a checklist can be pushed twice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { sql, type Db } from "../electron/db/connection";
import { closeTestDb, openTestDb, resetTestDb } from "./helpers/testDb";
import { applyPullResult, loadMasterIndexes, readCursors } from "../electron/db/repositories/masters";
import { confirm, createFromInward, loadChecklist, saveRows } from "../electron/db/repositories/checklists";
import { dueForPush, listQueue } from "../electron/db/repositories/outbox";
import { SyncEngine } from "../electron/sync/engine";
import { ErpNetworkError, type ErpnextClient, type PushResultRow } from "../electron/sync/erpnext";

let db: Db;

function seed(): void {
	applyPullResult(db, {
		rates_visible: true,
		server_time: "now",
		doctypes: {
			"Skin Type Range": {
				permitted: true,
				rows: [
					{ name: "Cow Small", skin_type: "Cow", range_name: "Cow Small", status: "Active", min_range: 5, max_range: 100, modified: "m1" },
				],
				children: {},
				cursor: { modified: "m1", name: "Cow Small" },
				has_more: false,
			},
			"Inward Raw Hide": {
				permitted: true,
				rows: [{ name: "IRH-1", vendor: "V", vendor_name: "Vendor", date: "2026-09-01", status: "Pending", reference_no: "R", total_qty: 2, modified: "m1" }],
				children: {
					raw_hide_details: [
						{ name: "D1", parent: "IRH-1", idx: 1, item_code: "RAW", item_name: "Raw", skin_type: "Cow", grade: "A", no_pieces: 2 },
					],
				},
				cursor: { modified: "m1", name: "IRH-1" },
				has_more: false,
			},
		},
	});
}

function confirmedChecklist(): string {
	const list = createFromInward(db, "IRH-1", "op");
	const indexes = loadMasterIndexes(db);
	saveRows(
		db,
		list.local_name,
		list.rows.map((row) => ({ id: row.id, feetage: 20, grade: "A" })),
		indexes
	);
	const result = confirm(db, list.local_name);
	expect(result.ok).toBe(true);
	return list.local_name;
}

function fakeClient(overrides: Partial<ErpnextClient> = {}): ErpnextClient {
	return {
		ping: vi.fn(),
		sessionBootstrap: vi.fn(),
		pull: vi.fn(),
		push: vi.fn(),
		updateInwardQty: vi.fn(),
		setConfig: vi.fn(),
		...overrides,
	} as unknown as ErpnextClient;
}

beforeAll(() => {
	db = openTestDb("sync");
});

afterAll(closeTestDb);

beforeEach(() => {
	resetTestDb(db);
	seed();
});

describe("push", () => {
	it("confirms a checklist and closes the GRN locally", async () => {
		const localName = confirmedChecklist();
		const uuid = loadChecklist(db, localName)!.offline_uuid;

		const push = vi.fn(async (): Promise<{ results: PushResultRow[] }> => ({
			results: [
				{ offline_uuid: uuid, ok: true, name: "QCCL-2026-00001", docstatus: 1, inward_no: "IRH-1", inward_status: "Complete" },
			],
		}));

		await new SyncEngine({ db, client: fakeClient({ push }) }).pushOnce();

		const list = loadChecklist(db, localName)!;
		expect(list.state).toBe("confirmed");
		expect(list.erp_name).toBe("QCCL-2026-00001");
		expect(
			(sql(db, "SELECT status FROM inward_raw_hides WHERE name = 'IRH-1'").get() as { status: string }).status
		).toBe("Complete");
	});

	it("confirms a merge checklist by closing the merge mirror", async () => {
		applyPullResult(db, {
			rates_visible: true,
			server_time: "now",
			doctypes: {
				"Merge Inward Raw Hide": {
					permitted: true,
					rows: [{ name: "MIRH-1", vendor: "V", vendor_name: "Vendor", date: "2026-09-01", status: "Pending", reference_no: "M", total_qty: 2, modified: "m1" }],
					children: {
						merge_raw_hide_details: [
							{ name: "MD1", parent: "MIRH-1", idx: 1, item_code: "RAW", item_name: "Raw", skin_type: "Cow", grade: "A", no_pieces: 2 },
						],
					},
					cursor: { modified: "m1", name: "MIRH-1" },
					has_more: false,
				},
			},
		});

		const merge = createFromInward(db, "MIRH-1", "op");
		const indexes = loadMasterIndexes(db);
		saveRows(
			db,
			merge.local_name,
			merge.rows.map((row) => ({ id: row.id, feetage: 20, grade: "A" })),
			indexes
		);
		expect(confirm(db, merge.local_name).ok).toBe(true);
		const uuid = loadChecklist(db, merge.local_name)!.offline_uuid;

		const push = vi.fn(async (): Promise<{ results: PushResultRow[] }> => ({
			results: [
				{ offline_uuid: uuid, ok: true, name: "QCCL-2026-00002", docstatus: 1, inward_no: "MIRH-1", grn_type: "Merge Inward Raw Hide", inward_status: "Complete" },
			],
		}));

		await new SyncEngine({ db, client: fakeClient({ push }) }).pushOnce();

		expect(loadChecklist(db, merge.local_name)!.erp_name).toBe("QCCL-2026-00002");
		expect(
			(sql(db, "SELECT status FROM merge_inward_raw_hides WHERE name = 'MIRH-1'").get() as {
				status: string;
			}).status
		).toBe("Complete");
	});

	it("sends only the fields the server does not recompute", async () => {
		confirmedChecklist();
		const push = vi.fn(async () => ({ results: [] as PushResultRow[] }));
		await new SyncEngine({ db, client: fakeClient({ push }) }).pushOnce();

		const [docs] = push.mock.calls[0] as unknown as [Record<string, unknown>[]];
		const row = (docs[0]!.qc_checklist_details as Record<string, unknown>[])[0]!;
		expect(Object.keys(row).sort()).toEqual(
			["feetage", "grade", "item_code", "no_pieces", "skin_type", "status"].sort()
		);
	});

	it("returns the batch to the queue when the server never answers", async () => {
		const localName = confirmedChecklist();
		const push = vi.fn(async () => {
			throw new ErpNetworkError("connect ECONNREFUSED");
		});

		const engine = new SyncEngine({ db, client: fakeClient({ push }) });
		await expect(engine.pushOnce()).rejects.toThrow(ErpNetworkError);

		const [row] = listQueue(db);
		// Not a rejection: the server may well have committed it, so no attempt is spent
		// and no backoff applies.
		expect(row!.attempts).toBe(0);
		expect(row!.state).toBe("queued");
		expect(dueForPush(db)).toHaveLength(1);
		expect(loadChecklist(db, localName)!.state).toBe("queued");
	});

	it("records a rejection as a failure with its reason", async () => {
		const localName = confirmedChecklist();
		const uuid = loadChecklist(db, localName)!.offline_uuid;
		const push = vi.fn(async () => ({
			results: [{ offline_uuid: uuid, ok: false, error: "Row 1: Grade is required" }] as PushResultRow[],
		}));

		await new SyncEngine({ db, client: fakeClient({ push }) }).pushOnce();

		const [row] = listQueue(db);
		expect(row!.state).toBe("failed");
		expect(row!.attempts).toBe(1);
		expect(row!.last_error).toBe("Row 1: Grade is required");
		expect(loadChecklist(db, localName)!.state).toBe("failed");
	});

	it("retries a row the server silently omitted", async () => {
		confirmedChecklist();
		// A partial response must not strand a document in 'sent' forever.
		const push = vi.fn(async () => ({ results: [] as PushResultRow[] }));
		await new SyncEngine({ db, client: fakeClient({ push }) }).pushOnce();

		const [row] = listQueue(db);
		expect(row!.state).toBe("queued");
		expect(row!.attempts).toBe(0);
	});

	it("does nothing when the queue is empty", async () => {
		const push = vi.fn();
		await new SyncEngine({ db, client: fakeClient({ push }) }).pushOnce();
		expect(push).not.toHaveBeenCalled();
	});

	it("is idempotent across a retry of a request that did commit", async () => {
		const localName = confirmedChecklist();
		const uuid = loadChecklist(db, localName)!.offline_uuid;

		let attempt = 0;
		const push = vi.fn(async () => {
			attempt += 1;
			// First call: the server committed, then the connection dropped.
			if (attempt === 1) throw new ErpNetworkError("socket hang up");
			// Retry: the server recognises the offline_uuid and returns the same document.
			return {
				results: [
					{ offline_uuid: uuid, ok: true, name: "QCCL-2026-00001", docstatus: 1, inward_no: "IRH-1", inward_status: "Complete" },
				] as PushResultRow[],
			};
		});

		const engine = new SyncEngine({ db, client: fakeClient({ push }) });
		await expect(engine.pushOnce()).rejects.toThrow(ErpNetworkError);
		await engine.pushOnce();

		expect(loadChecklist(db, localName)!.erp_name).toBe("QCCL-2026-00001");
		expect(listQueue(db)).toHaveLength(1); // one document, pushed once, confirmed once
	});
});

describe("pull", () => {
	it("advances the cursor and marks the station online", async () => {
		const pull = vi.fn(async () => ({
			rates_visible: true,
			server_time: "now",
			doctypes: {
				Grade: {
					permitted: true,
					rows: [{ name: "C", grade: "C", modified: "m9" }],
					children: {},
					cursor: { modified: "m9", name: "C" },
					has_more: false,
				},
			},
		}));

		const engine = new SyncEngine({ db, client: fakeClient({ pull }) });
		await engine.pullOnce();

		expect(readCursors(db)["Grade"]).toEqual({ modified: "m9", name: "C" });
		expect(engine.getStatus().online).toBe(true);
	});

	it("keeps paging while the server reports more", async () => {
		let round = 0;
		const pull = vi.fn(async () => {
			round += 1;
			return {
				rates_visible: true,
				server_time: "now",
				doctypes: {
					Grade: {
						permitted: true,
						rows: [{ name: `G${round}`, grade: `G${round}`, modified: `m${round}` }],
						children: {},
						cursor: { modified: `m${round}`, name: `G${round}` },
						has_more: round < 3,
					},
				},
			};
		});

		await new SyncEngine({ db, client: fakeClient({ pull }) }).pullOnce();
		expect(pull).toHaveBeenCalledTimes(3);
		expect((sql(db, "SELECT COUNT(*) AS n FROM grades").get() as { n: number }).n).toBe(3);
	});

	it("reports the station offline when the pull cannot reach the server", async () => {
		const pull = vi.fn(async () => {
			throw new ErpNetworkError("getaddrinfo ENOTFOUND");
		});
		const engine = new SyncEngine({ db, client: fakeClient({ pull }) });
		await expect(engine.pullOnce()).rejects.toThrow(ErpNetworkError);
		expect(engine.getStatus().online).toBe(false);
	});
});
