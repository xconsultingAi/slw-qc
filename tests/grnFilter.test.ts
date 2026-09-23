/**
 * Finding a GRN.
 *
 * An operator arrives holding a docket and knows one thing: a number, or a vendor's name.
 * A station that has been running a while mirrors hundreds of GRNs, so the list has to
 * narrow on whatever they happen to remember.
 */
import { describe, expect, it } from "vitest";

import { countByStatus, filterInwards, matchesStatus, matchesText } from "../frontend/src/composables/grnFilter";
// Type-only, so importing the preload here never pulls in the electron runtime.
import type { InwardOption } from "../electron/preload";

function grn(overrides: Partial<InwardOption> = {}): InwardOption {
	return {
		grn_type: "Inward Raw Hide",
		name: "IRH-2026-00001",
		vendor: "SUP-0001",
		vendor_name: "Hide Traders Ltd",
		reference_no: "DOCKET-77",
		date: "2026-09-01",
		status: "Pending",
		total_qty: 50,
		local_checklist: null,
		local_state: null,
		...overrides,
	};
}

describe("searching", () => {
	it("matches on the GRN number, including a fragment", () => {
		expect(matchesText(grn(), "00001")).toBe(true);
		expect(matchesText(grn(), "IRH-2026")).toBe(true);
		expect(matchesText(grn(), "00002")).toBe(false);
	});

	it("matches on the vendor name, case insensitively", () => {
		expect(matchesText(grn(), "hide traders")).toBe(true);
		expect(matchesText(grn(), "HIDE")).toBe(true);
	});

	it("matches on the supplier reference printed on the docket", () => {
		expect(matchesText(grn(), "docket-77")).toBe(true);
	});

	it("matches on the date", () => {
		expect(matchesText(grn(), "2026-09")).toBe(true);
	});

	it("ANDs the terms, so column order does not matter", () => {
		// "hide 09" should find a September GRN from Hide Traders.
		expect(matchesText(grn(), "hide 09")).toBe(true);
		expect(matchesText(grn(), "09 hide")).toBe(true);
		expect(matchesText(grn(), "hide 12")).toBe(false);
	});

	it("treats an empty or whitespace search as no filter", () => {
		expect(matchesText(grn(), "")).toBe(true);
		expect(matchesText(grn(), "   ")).toBe(true);
	});

	it("tolerates missing fields rather than throwing", () => {
		const sparse = grn({ vendor_name: null, reference_no: null, date: null });
		expect(matchesText(sparse, "IRH")).toBe(true);
		expect(matchesText(sparse, "traders")).toBe(false);
	});
});

describe("status tabs", () => {
	const fresh = grn({ name: "IRH-1" });
	const started = grn({ name: "IRH-2", local_checklist: "QC-00001", local_state: "draft" });

	it("separates started from not started", () => {
		expect(matchesStatus(fresh, "available")).toBe(true);
		expect(matchesStatus(fresh, "started")).toBe(false);
		expect(matchesStatus(started, "started")).toBe(true);
		expect(matchesStatus(started, "available")).toBe(false);
	});

	it("shows everything under All", () => {
		expect(matchesStatus(fresh, "all")).toBe(true);
		expect(matchesStatus(started, "all")).toBe(true);
	});

	it("counts each tab", () => {
		expect(countByStatus([fresh, started, grn({ name: "IRH-3" })])).toEqual({
			all: 3,
			available: 2,
			started: 1,
		});
	});
});

describe("combined filtering", () => {
	const options = [
		grn({ name: "IRH-1", vendor_name: "Hide Traders Ltd" }),
		grn({ name: "IRH-2", vendor_name: "Leather Co", local_checklist: "QC-00001", local_state: "draft" }),
		grn({ name: "IRH-3", vendor_name: "Hide Traders Ltd", local_checklist: "QC-00002", local_state: "confirmed" }),
	];

	it("applies search and status together", () => {
		expect(filterInwards(options, { text: "hide", status: "all" }).map((o) => o.name)).toEqual([
			"IRH-1",
			"IRH-3",
		]);
		expect(filterInwards(options, { text: "hide", status: "started" }).map((o) => o.name)).toEqual(["IRH-3"]);
		expect(filterInwards(options, { text: "hide", status: "available" }).map((o) => o.name)).toEqual(["IRH-1"]);
	});

	it("returns nothing rather than everything when nothing matches", () => {
		expect(filterInwards(options, { text: "nonexistent", status: "all" })).toEqual([]);
	});

	it("preserves the incoming order", () => {
		expect(filterInwards(options, { text: "", status: "all" }).map((o) => o.name)).toEqual([
			"IRH-1",
			"IRH-2",
			"IRH-3",
		]);
	});
});
