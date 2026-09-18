/**
 * Repository tests against a real SQLite file.
 *
 * These run on disk rather than in memory on purpose: WAL mode, foreign keys and the
 * transaction semantics that confirm() depends on are all connection-level behaviour,
 * and an in-memory database does not exercise them the same way.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { migrate, sql, type Db } from "../electron/db/connection";
import { closeTestDb, openTestDb, resetTestDb, SCHEMA } from "./helpers/testDb";
import {
	applyPullResult,
	listOpenInwards,
	loadMasterIndexes,
	readCursors,
	type PullResult,
} from "../electron/db/repositories/masters";
import {
	appendRow,
	applyServerConfirmation,
	confirm,
	createFromInward,
	formatLocalName,
	loadChecklist,
	removeRow,
	saveRows,
	setReturnPieces,
	updateHeader,
} from "../electron/db/repositories/checklists";
import {
	backoffSeconds,
	dueForPush,
	markConfirmed,
	markFailed,
	markSent,
	queueCounts,
	releaseInFlight,
	retryNow,
} from "../electron/db/repositories/outbox";

let db: Db;

function pullFixture(): PullResult {
	return {
		rates_visible: true,
		server_time: "2026-09-09 10:00:00",
		doctypes: {
			Grade: {
				permitted: true,
				rows: [
					{ name: "A", grade: "A", modified: "2026-09-01 10:00:00" },
					{ name: "B", grade: "B", modified: "2026-09-01 10:00:01" },
				],
				children: {},
				cursor: { modified: "2026-09-01 10:00:01", name: "B" },
				has_more: false,
			},
			"Skin Type Range": {
				permitted: true,
				rows: [
					{ name: "Cow Small", skin_type: "Cow", range_name: "Cow Small", status: "Active", min_range: 5, max_range: 15, modified: "m1" },
					{ name: "Cow Large", skin_type: "Cow", range_name: "Cow Large", status: "Active", min_range: 15.01, max_range: 100, modified: "m2" },
				],
				children: {},
				cursor: { modified: "m2", name: "Cow Large" },
				has_more: false,
			},
			"Tounch Rate": {
				permitted: true,
				rows: [{ name: "TR-1", skin_type: "Cow", grade: "A", entry_date: "2026-09-01", creation: "2026-09-01 09:00:00", modified: "m1" }],
				children: {
					tounch_size_rate: [
						{ name: "TSD-1", parent: "TR-1", idx: 1, size: "Cow Small", size_feetage: 1, tounch_rate: 120 },
						{ name: "TSD-2", parent: "TR-1", idx: 2, size: "Cow Large", size_feetage: 1, tounch_rate: 165 },
					],
				},
				cursor: { modified: "m1", name: "TR-1" },
				has_more: false,
			},
			Item: {
				permitted: true,
				rows: [{ name: "RAW-COW", item_name: "Raw Cow", skin_type: "Cow", has_variants: 1, is_stock_item: 1, disabled: 0, modified: "m1" }],
				children: {},
				cursor: { modified: "m1", name: "RAW-COW" },
				has_more: false,
			},
			"Inward Raw Hide": {
				permitted: true,
				rows: [
					{ name: "IRH-1", vendor: "V1", vendor_name: "Vendor One", date: "2026-09-01", status: "Pending", reference_no: "R1", total_qty: 5, modified: "m1" },
					{ name: "IRH-DONE", vendor: "V1", vendor_name: "Vendor One", date: "2026-09-01", status: "Complete", reference_no: "R2", total_qty: 2, modified: "m2" },
				],
				children: {
					raw_hide_details: [
						{ name: "D1", parent: "IRH-1", idx: 1, item_code: "RAW-COW", item_name: "Raw Cow", skin_type: "Cow", grade: "A", no_pieces: 3 },
						{ name: "D2", parent: "IRH-1", idx: 2, item_code: "RAW-COW", item_name: "Raw Cow", skin_type: "Cow", grade: "B", no_pieces: 2 },
						{ name: "D3", parent: "IRH-DONE", idx: 1, item_code: "RAW-COW", item_name: "Raw Cow", skin_type: "Cow", grade: "A", no_pieces: 2 },
					],
				},
				cursor: { modified: "m2", name: "IRH-DONE" },
				has_more: false,
			},
			Employee: { permitted: false, rows: [], children: {}, cursor: null, has_more: false },
		},
	};
}

beforeAll(() => {
	db = openTestDb("db");
});

afterAll(closeTestDb);

beforeEach(() => {
	resetTestDb(db);
});

describe("schema and migrations", () => {
	it("enables the pragmas the write path depends on", () => {
		expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
		expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
	});

	it("re-applies the schema without disturbing existing data", () => {
		// Every statement is CREATE ... IF NOT EXISTS, so an upgrade run over a populated
		// database must be a no-op rather than a reset.
		applyPullResult(db, pullFixture());
		migrate(db, SCHEMA);
		expect((sql(db, "SELECT COUNT(*) AS n FROM grades").get() as { n: number }).n).toBe(2);
	});

	it("cascades child rows when a checklist is deleted", () => {
		applyPullResult(db, pullFixture());
		const list = createFromInward(db, "IRH-1", "op");
		sql(db, "DELETE FROM qc_check_lists WHERE local_name = ?").run(list.local_name);
		const left = sql(db, "SELECT COUNT(*) AS n FROM qc_check_list_details WHERE parent = ?")
			.get(list.local_name) as { n: number };
		expect(left.n).toBe(0);
	});
});

describe("master mirror", () => {
	it("upserts rows, children and cursors in one pass", () => {
		const counts = applyPullResult(db, pullFixture());
		expect(counts.Grade).toBe(2);
		expect(readCursors(db)["Grade"]).toEqual({ modified: "2026-09-01 10:00:01", name: "B" });
		expect(
			(sql(db, "SELECT COUNT(*) AS n FROM touch_size_details").get() as { n: number }).n
		).toBe(2);
	});

	it("is safe to apply twice", () => {
		applyPullResult(db, pullFixture());
		applyPullResult(db, pullFixture());
		expect((sql(db, "SELECT COUNT(*) AS n FROM grades").get() as { n: number }).n).toBe(2);
		expect((sql(db, "SELECT COUNT(*) AS n FROM touch_size_details").get() as { n: number }).n).toBe(2);
	});

	it("removes child rows the server no longer sends", () => {
		applyPullResult(db, pullFixture());
		const second = pullFixture();
		second.doctypes["Tounch Rate"]!.children.tounch_size_rate = [
			{ name: "TSD-1", parent: "TR-1", idx: 1, size: "Cow Small", size_feetage: 1, tounch_rate: 130 },
		];
		applyPullResult(db, second);

		const rows = sql(db, "SELECT size, tounch_rate FROM touch_size_details").all();
		// The withdrawn band must not linger and keep pricing rows the server stopped pricing.
		expect(rows).toEqual([{ size: "Cow Small", tounch_rate: 130 }]);
	});

	it("records a withheld doctype instead of failing the pull", () => {
		applyPullResult(db, pullFixture());
		const cursor = sql(db, "SELECT permitted FROM sync_cursor WHERE doctype = 'Employee'").get() as {
			permitted: number;
		};
		expect(cursor.permitted).toBe(0);
	});

	it("builds indexes that resolve a size and a rate", () => {
		applyPullResult(db, pullFixture());
		const indexes = loadMasterIndexes(db);
		expect(indexes.ratesVisible).toBe(true);
		expect(indexes.grades).toEqual(["A", "B"]);
		expect(indexes.warnings.overlaps).toEqual([]);
	});

	it("mirrors employees for the Selector and Measurer pickers", () => {
		const seeded = pullFixture();
		seeded.doctypes.Employee = {
			permitted: true,
			rows: [
				{ name: "EMP-1", employee_name: "Ali Raza", status: "Active", modified: "m1" },
				{ name: "EMP-2", employee_name: "Bina Shah", status: "Active", modified: "m2" },
			],
			children: {},
			cursor: { modified: "m2", name: "EMP-2" },
			has_more: false,
		};
		applyPullResult(db, seeded);
		expect(loadMasterIndexes(db).employees).toEqual([
			{ name: "EMP-1", employee_name: "Ali Raza" },
			{ name: "EMP-2", employee_name: "Bina Shah" },
		]);
	});

	it("offers only GRNs that are not already Complete", () => {
		applyPullResult(db, pullFixture());
		expect(listOpenInwards(db).map((row) => row.name)).toEqual(["IRH-1"]);
	});

	it("flags a GRN that already has a local checklist", () => {
		applyPullResult(db, pullFixture());
		createFromInward(db, "IRH-1", "op");
		const [option] = listOpenInwards(db);
		expect(option!.local_checklist).toMatch(/^QC-\d{5}$/);
		expect(option!.local_state).toBe("draft");
	});
});

describe("local naming", () => {
	beforeEach(() => applyPullResult(db, pullFixture()));

	/** A GRN of its own, because one checklist per GRN is now enforced. */
	function extraGrn(name: string): string {
		sql(
			db,
			`INSERT INTO inward_raw_hides (name, vendor, vendor_name, date, status, reference_no, total_qty)
			 VALUES (?, 'V1', 'Vendor One', '2026-09-01', 'Pending', ?, 1)`
		).run(name, name);
		sql(
			db,
			`INSERT INTO inward_raw_hide_details (name, parent, idx, item_code, item_name, skin_type, grade, no_pieces)
			 VALUES (?, ?, 1, 'RAW-COW', 'Raw Cow', 'Cow', 'A', 1)`
		).run(`${name}-D1`, name);
		return name;
	}

	it("names checklists in a running sequence a person can read", () => {
		expect(createFromInward(db, "IRH-1", "op").local_name).toBe("QC-00001");
		expect(createFromInward(db, extraGrn("IRH-A"), "op").local_name).toBe("QC-00002");
		expect(createFromInward(db, extraGrn("IRH-B"), "op").local_name).toBe("QC-00003");
	});

	it("formats the sequence with a readable prefix and padding", () => {
		expect(formatLocalName(1)).toBe("QC-00001");
		expect(formatLocalName(42)).toBe("QC-00042");
		expect(formatLocalName(99999)).toBe("QC-99999");
		// Widens rather than truncating, so the name stays unique past five digits.
		expect(formatLocalName(100000)).toBe("QC-100000");
	});

	it("never reuses a name after a checklist is deleted", () => {
		const first = createFromInward(db, "IRH-1", "op");
		sql(db, "DELETE FROM qc_check_lists WHERE local_name = ?").run(first.local_name);
		expect(createFromInward(db, "IRH-1", "op").local_name).toBe("QC-00002");
	});

	it("rebuilds the counter from existing documents if it is lost", () => {
		createFromInward(db, "IRH-1", "op");
		createFromInward(db, extraGrn("IRH-A"), "op");

		// What a cleared meta table looks like. Restarting at 1 here would collide with
		// QC-00001 and fail the insert.
		sql(db, "DELETE FROM meta WHERE key = 'local_series'").run();

		expect(createFromInward(db, extraGrn("IRH-B"), "op").local_name).toBe("QC-00003");
	});

	it("keeps the sync key separate from the readable name", () => {
		const list = createFromInward(db, "IRH-1", "op");
		// The name repeats across stations by design; the uuid is what must not.
		expect(list.local_name).toBe("QC-00001");
		expect(list.offline_uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(list.offline_uuid).not.toContain(list.local_name);
	});

	it("does not send the local name to the server", () => {
		// It is a per-station label and would be ambiguous on the server.
		const list = createFromInward(db, "IRH-1", "op");
		const indexes = loadMasterIndexes(db);
		saveRows(db, list.local_name, list.rows.map((row) => ({ id: row.id, feetage: 12, grade: "A" })), indexes);
		confirm(db, list.local_name);

		const [queued] = dueForPush(db);
		const payload = JSON.parse(queued!.payload_json) as Record<string, unknown>;
		expect(payload).not.toHaveProperty("local_name");
		expect(payload.offline_uuid).toBe(list.offline_uuid);
	});
});

describe("checklist drafting", () => {
	beforeEach(() => applyPullResult(db, pullFixture()));

	it("explodes a GRN into one row per hide", () => {
		const list = createFromInward(db, "IRH-1", "op");
		expect(list.rows).toHaveLength(5); // 3 + 2 pieces
		expect(list.rows.map((row) => row.idx)).toEqual([1, 2, 3, 4, 5]);
		expect(list.vendor_name).toBe("Vendor One");
	});

	it("does not carry the supplier's grade onto the QC rows", () => {
		// The GRN claims grade A and B; QC must judge each hide for itself.
		const list = createFromInward(db, "IRH-1", "op");
		expect(list.rows.every((row) => row.grade === null)).toBe(true);
	});

	it("resolves size and rate from feetage alone", () => {
		const list = createFromInward(db, "IRH-1", "op");
		const indexes = loadMasterIndexes(db);
		const first = list.rows[0]!;

		saveRows(db, list.local_name, [{ id: first.id, feetage: 8, grade: "A" }], indexes);

		const [row] = loadChecklist(db, list.local_name)!.rows;
		expect(row!.size).toBe("Cow Small");
		expect(row!.rate).toBe(120);
		expect(row!.net_amount).toBe(960);
	});

	it("re-resolves the size when a feetage is corrected", () => {
		const list = createFromInward(db, "IRH-1", "op");
		const indexes = loadMasterIndexes(db);
		const first = list.rows[0]!;

		saveRows(db, list.local_name, [{ id: first.id, feetage: 8, grade: "A" }], indexes);
		saveRows(db, list.local_name, [{ id: first.id, feetage: 50 }], indexes);

		const [row] = loadChecklist(db, list.local_name)!.rows;
		expect(row!.size).toBe("Cow Large");
		expect(row!.rate).toBe(165);
	});

	it("keeps an out-of-range feetage rather than zeroing the cell", () => {
		// The desk form resets this to 0 and throws. Losing the operator's measurement is
		// the exact complaint the desktop client exists to fix.
		const list = createFromInward(db, "IRH-1", "op");
		const indexes = loadMasterIndexes(db);
		saveRows(db, list.local_name, [{ id: list.rows[0]!.id, feetage: 3 }], indexes);
		expect(loadChecklist(db, list.local_name)!.rows[0]!.feetage).toBe(3);
	});

	it("keeps a running grand total", () => {
		const list = createFromInward(db, "IRH-1", "op");
		const indexes = loadMasterIndexes(db);
		saveRows(
			db,
			list.local_name,
			list.rows.map((row) => ({ id: row.id, feetage: 10, grade: "A" })),
			indexes
		);
		// 5 rows * 10 ft * 120 = 6000
		expect(loadChecklist(db, list.local_name)!.grand_total).toBe(6000);
	});

	it("records selectors and measurers", () => {
		const list = createFromInward(db, "IRH-1", "op");
		updateHeader(db, list.local_name, { selectors: ["EMP-1"], measurers: ["EMP-2", "EMP-3"] });
		const reloaded = loadChecklist(db, list.local_name)!;
		expect(reloaded.selectors).toEqual(["EMP-1"]);
		expect(reloaded.measurers).toEqual(["EMP-2", "EMP-3"]);
	});

	it("trims rows and renumbers, repeatedly", () => {
		const list = createFromInward(db, "IRH-1", "op");
		expect(setReturnPieces(db, list.local_name, 2)).toBe(3);
		expect(loadChecklist(db, list.local_name)!.rows.map((r) => r.idx)).toEqual([1, 2, 3]);
		// The desk form locks after one use; a draft here stays editable.
		expect(setReturnPieces(db, list.local_name, 1)).toBe(2);
	});

	it("refuses to trim more rows than exist", () => {
		const list = createFromInward(db, "IRH-1", "op");
		expect(() => setReturnPieces(db, list.local_name, 99)).toThrow(/greater than available rows/);
	});
});

describe("appending a row", () => {
	beforeEach(() => applyPullResult(db, pullFixture()));

	it("copies the last row and continues the numbering", () => {
		const list = createFromInward(db, "IRH-1", "op");
		const appendResult = appendRow(db, list.local_name)!;

		expect(appendResult.rows).toHaveLength(6);
		expect(appendResult.rows.map((r) => r.idx)).toEqual([1, 2, 3, 4, 5, 6]);

		const last = appendResult.rows.at(-1)!;
		expect(last.item_code).toBe(appendResult.rows[4]!.item_code);
		expect(last.skin_type).toBe(appendResult.rows[4]!.skin_type);
		expect(last.grade).toBe(appendResult.rows[4]!.grade);
	});

	it("carries a measurement forward so a missed hide is not silently recreated blank", () => {
		const list = createFromInward(db, "IRH-1", "op");
		const indexes = loadMasterIndexes(db);
		saveRows(db, list.local_name, [{ id: list.rows.at(-1)!.id, feetage: 8, grade: "A" }], indexes);
		const measured = loadChecklist(db, list.local_name)!.rows.at(-1)!;

		const appended = appendRow(db, list.local_name)!.rows.at(-1)!;
		expect(appended.grade).toBe("A");
		expect(appended.feetage).toBe(8);
		expect(appended.size).toBe(measured.size);
	});

	it("adds a single default row to an empty checklist instead of failing", () => {
		const list = createFromInward(db, "IRH-1", "op");
		sql(db, "DELETE FROM qc_check_list_details WHERE parent = ?").run(list.local_name);

		const appended = appendRow(db, list.local_name)!.rows;
		expect(appended).toHaveLength(1);
		expect(appended[0]!.idx).toBe(1);
		expect(appended[0]!.no_pieces).toBe(1);
	});

	it("refuses once the checklist can no longer be edited", () => {
		const list = createFromInward(db, "IRH-1", "op");
		sql(db, "UPDATE qc_check_lists SET state = 'confirmed' WHERE local_name = ?").run(list.local_name);
		expect(() => appendRow(db, list.local_name)).toThrow(/can no longer be edited/);
	});
});

describe("removing a row", () => {
	beforeEach(() => applyPullResult(db, pullFixture()));

	it("deletes the row and renumbers the rest so idx stays 1..n", () => {
		const list = createFromInward(db, "IRH-1", "op");
		// Remove the third hide; the fourth must become 3, not stay 4.
		const middle = list.rows[2]!;
		const reloaded = removeRow(db, list.local_name, middle.id)!;

		expect(reloaded.rows).toHaveLength(4);
		expect(reloaded.rows.map((r) => r.idx)).toEqual([1, 2, 3, 4]);
		expect(reloaded.rows.some((r) => r.id === middle.id)).toBe(false);
	});

	it("recalculates the grand total for what is left", () => {
		const list = createFromInward(db, "IRH-1", "op");
		const indexes = loadMasterIndexes(db);
		saveRows(
			db,
			list.local_name,
			list.rows.map((row) => ({ id: row.id, feetage: 10, grade: "A" })),
			indexes
		);
		// 5 rows * 10 ft * 120 = 6000; removing one leaves 4800.
		const reloaded = removeRow(db, list.local_name, list.rows[0]!.id)!;
		expect(reloaded.rows).toHaveLength(4);
		expect(reloaded.grand_total).toBe(4800);
	});

	it("becomes an empty checklist when the last row goes", () => {
		const list = createFromInward(db, "IRH-1", "op");
		let rows = list.rows;
		while (rows.length) {
			rows = removeRow(db, list.local_name, rows[0]!.id)!.rows;
		}
		expect(rows).toHaveLength(0);
	});

	it("refuses a row that does not belong to this checklist", () => {
		const list = createFromInward(db, "IRH-1", "op");
		expect(() => removeRow(db, list.local_name, 9999)).toThrow(/does not belong to checklist/);
	});

	it("refuses once the checklist can no longer be edited", () => {
		const list = createFromInward(db, "IRH-1", "op");
		sql(db, "UPDATE qc_check_lists SET state = 'queued' WHERE local_name = ?").run(list.local_name);
		expect(() => removeRow(db, list.local_name, list.rows[0]!.id)).toThrow(/can no longer be edited/);
	});
});

describe("one checklist per GRN", () => {
	beforeEach(() => applyPullResult(db, pullFixture()));

	it("refuses a second checklist for a GRN already being measured", () => {
		const first = createFromInward(db, "IRH-1", "op");
		// Two checklists would each carry their own offline_uuid, each submit, and the GRN
		// would be measured and paid for twice.
		expect(() => createFromInward(db, "IRH-1", "op")).toThrow(
			new RegExp(`already has an open checklist, ${first.local_name}`)
		);
	});

	it("refuses one for a GRN already confirmed", () => {
		const first = createFromInward(db, "IRH-1", "op");
		sql(db, "UPDATE qc_check_lists SET state = 'confirmed' WHERE local_name = ?").run(first.local_name);
		expect(() => createFromInward(db, "IRH-1", "op")).toThrow(/was already measured/);
	});

	it("allows a retry after a failed one, which never reached ERPNext", () => {
		const first = createFromInward(db, "IRH-1", "op");
		sql(db, "UPDATE qc_check_lists SET state = 'failed' WHERE local_name = ?").run(first.local_name);
		expect(() => createFromInward(db, "IRH-1", "op")).not.toThrow();
	});

	it("refuses a GRN another station has already completed", () => {
		sql(db, "UPDATE inward_raw_hides SET status = 'Complete' WHERE name = 'IRH-1'").run();
		expect(() => createFromInward(db, "IRH-1", "op")).toThrow(/already marked Complete/);
	});

	it("leaves no half-created checklist behind when it refuses", () => {
		createFromInward(db, "IRH-1", "op");
		expect(() => createFromInward(db, "IRH-1", "op")).toThrow();
		const count = sql(db, "SELECT COUNT(*) AS n FROM qc_check_lists").get() as { n: number };
		expect(count.n).toBe(1);
	});
});

describe("confirming and the outbox", () => {
	function draftReadyToConfirm() {
		applyPullResult(db, pullFixture());
		const list = createFromInward(db, "IRH-1", "op");
		const indexes = loadMasterIndexes(db);
		saveRows(
			db,
			list.local_name,
			list.rows.map((row) => ({ id: row.id, feetage: 12, grade: "A" })),
			indexes
		);
		return list.local_name;
	}

	it("blocks a confirm that the server would reject, without queueing anything", () => {
		applyPullResult(db, pullFixture());
		const list = createFromInward(db, "IRH-1", "op");

		const result = confirm(db, list.local_name);
		expect(result.ok).toBe(false);
		expect(result.problems.some((p) => p.message.includes("Grade is required"))).toBe(true);
		expect(queueCounts(db).queued).toBe(0);
		expect(loadChecklist(db, list.local_name)!.state).toBe("draft");
	});

	it("words its complaints exactly as the server does", () => {
		applyPullResult(db, pullFixture());
		const list = createFromInward(db, "IRH-1", "op");
		const indexes = loadMasterIndexes(db);
		saveRows(db, list.local_name, [{ id: list.rows[0]!.id, feetage: 500, grade: "A" }], indexes);

		const problems = confirm(db, list.local_name).problems;
		expect(problems[0]!.message).toBe("Row 1: Feetage 500 must be between 5 and 100");
	});

	it("writes the document state and the outbox row atomically", () => {
		const localName = draftReadyToConfirm();
		expect(confirm(db, localName).ok).toBe(true);

		expect(loadChecklist(db, localName)!.state).toBe("queued");
		const [queued] = dueForPush(db);
		expect(queued!.local_name).toBe(localName);

		const payload = JSON.parse(queued!.payload_json);
		expect(payload.qc_checklist_details).toHaveLength(5);
		// Thin payload: the server recomputes all of these.
		expect(payload.qc_checklist_details[0]).not.toHaveProperty("rate");
		expect(payload.qc_checklist_details[0]).not.toHaveProperty("size");
		expect(payload).not.toHaveProperty("grand_total");
	});

	it("locks a confirmed checklist against further edits", () => {
		const localName = draftReadyToConfirm();
		confirm(db, localName);
		const row = loadChecklist(db, localName)!.rows[0]!;
		expect(() => saveRows(db, localName, [{ id: row.id, feetage: 20 }], loadMasterIndexes(db))).toThrow(
			/can no longer be edited/
		);
	});

	it("backs off exponentially and caps at 15 minutes", () => {
		expect([0, 1, 2, 3, 8, 20].map(backoffSeconds)).toEqual([1, 2, 4, 8, 256, 256]);
		expect(backoffSeconds(99)).toBeLessThanOrEqual(900);
	});

	it("counts a rejection as an attempt", () => {
		const localName = draftReadyToConfirm();
		confirm(db, localName);
		const uuid = loadChecklist(db, localName)!.offline_uuid;

		markFailed(db, uuid, "Row 1: Grade is required");
		const row = dueForPush(db, 10).find((r) => r.offline_uuid === uuid) ?? null;
		const stored = sql(db, "SELECT attempts, state, last_error FROM outbox WHERE offline_uuid = ?").get(uuid) as {
			attempts: number;
			state: string;
			last_error: string;
		};
		expect(stored.attempts).toBe(1);
		expect(stored.state).toBe("failed");
		expect(stored.last_error).toContain("Grade is required");
		expect(row).toBeNull(); // held back by the backoff
		expect(loadChecklist(db, localName)!.state).toBe("failed");
	});

	it("does NOT consume an attempt when the request never got an answer", () => {
		// A timeout is not a rejection: the server may have committed. Counting it would
		// push a merely-disconnected station into a 15 minute backoff for nothing.
		const localName = draftReadyToConfirm();
		confirm(db, localName);
		const uuid = loadChecklist(db, localName)!.offline_uuid;

		markSent(db, [uuid]);
		releaseInFlight(db, [uuid]);

		const stored = sql(db, "SELECT attempts, state FROM outbox WHERE offline_uuid = ?").get(uuid) as {
			attempts: number;
			state: string;
		};
		expect(stored.attempts).toBe(0);
		expect(stored.state).toBe("queued");
		expect(dueForPush(db)).toHaveLength(1);
	});

	it("retries on demand, clearing the backoff", () => {
		const localName = draftReadyToConfirm();
		confirm(db, localName);
		const uuid = loadChecklist(db, localName)!.offline_uuid;
		markFailed(db, uuid, "boom");
		retryNow(db, uuid);
		expect(dueForPush(db)).toHaveLength(1);
	});

	it("mirrors a confirmation and closes the GRN", () => {
		const localName = draftReadyToConfirm();
		confirm(db, localName);
		const uuid = loadChecklist(db, localName)!.offline_uuid;

		markConfirmed(db, uuid, "QCCL-2026-00001");
		applyServerConfirmation(db, uuid, "QCCL-2026-00001", "IRH-1", "Complete");

		const list = loadChecklist(db, localName)!;
		expect(list.state).toBe("confirmed");
		expect(list.erp_name).toBe("QCCL-2026-00001");
		// The finished GRN must stop being offered, or the operator redoes the work.
		expect(listOpenInwards(db)).toEqual([]);
	});
});
