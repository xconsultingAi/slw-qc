/**
 * Per-column header filters.
 *
 * These rules are what let an operator on a 2,000-hide GRN find the one rejected row, a
 * single vendor's batch, or all the hides of a size without scrolling: each column's box
 * keeps only the rows whose text contains what was typed. The matching is deliberate and
 * simple - case-insensitive contains on each active column, columns combined with AND,
 * unused columns never restricting - so the grid can answer the question in one pass.
 */
import { describe, expect, it } from "vitest";

import type { DetailRow } from "../electron/db/repositories/checklists";
import { filterRows, rowSearchText, type RowFilters } from "../frontend/src/composables/rowFilter";

function row(overrides: Partial<DetailRow> = {}): DetailRow {
	return {
		id: 1,
		idx: 1,
		item_code: "TCP-001",
		item_name: "Cow Pelt",
		skin_type: "Cow",
		grade: "A",
		size: "M",
		status: "Accepted",
		feetage: 12.5,
		no_pieces: 1,
		rate: 0,
		net_amount: 0,
		...overrides,
	};
}

describe("rowSearchText", () => {
	it("combines the item code and name so either phrase finds the row", () => {
		const itemCode = row({ item_code: "TCP-001", item_name: "Cow Pelt" });
		expect(rowSearchText(itemCode, "item")).toBe("TCP-001 Cow Pelt");
	});

	it("renders blanks as empty text so searching never matches a missing value", () => {
		const partiallyFilled = row({ item_name: null, grade: null, size: null, feetage: 0 });
		expect(rowSearchText(partiallyFilled, "item")).toBe("TCP-001");
		expect(rowSearchText(partiallyFilled, "grade")).toBe("");
		expect(rowSearchText(partiallyFilled, "size")).toBe("");
		expect(rowSearchText(partiallyFilled, "feetage")).toBe("");
	});
});

describe("filterRows", () => {
	const rows = [
		row({ idx: 1, item_code: "TCP-001", skin_type: "Cow", grade: "A", feetage: 12.5, size: "M" }),
		row({ idx: 2, item_code: "TCP-002", skin_type: "Sheep", grade: "B", feetage: 8, size: "L" }),
		row({ idx: 3, item_code: "GO-001", skin_type: "Goat", grade: "A", feetage: 0, size: "S" }),
	];

	it("returns every row when no filter has text", () => {
		for (const filters of [{}, { grade: " " }, { item: "", skin: "  " }]) {
			expect(filterRows(rows, filters)).toEqual(rows);
		}
	});

	it("keeps only the rows whose text contains the filter, case-insensitively", () => {
		expect(filterRows(rows, { item: "tcp" }).map((r) => r.idx)).toEqual([1, 2]);
		expect(filterRows(rows, { grade: "a" }).map((r) => r.idx)).toEqual([1, 3]);
	});

	it("matches numbers straight from the visible cell text", () => {
		expect(filterRows(rows, { feetage: "12.5" }).map((r) => r.idx)).toEqual([1]);
		expect(filterRows(rows, { idx: "1" }).map((r) => r.idx)).toEqual([1]);
	});

	it("combines filters with AND so one box narrows the other", () => {
		expect(filterRows(rows, { grade: "a", skin: "cow" }).map((r) => r.idx)).toEqual([1]);
		expect(filterRows(rows, { grade: "a", skin: "goat" }).map((r) => r.idx)).toEqual([3]);
		expect(filterRows(rows, { grade: "a", skin: "sheep" })).toEqual([]);
	});

	it("trims the filter so surrounding spaces never hide a match", () => {
		expect(filterRows(rows, { grade: "  a  " }).map((r) => r.idx)).toEqual([1, 3]);
	});

	it("never mutates the caller's array", () => {
		const copy = rows.map((r) => ({ ...r }));
		filterRows(rows, { grade: "a" });
		expect(rows).toEqual(copy);
	});

	it("returns a copy even when nothing is filtered", () => {
		const result = filterRows(rows, {}) as DetailRow[];
		expect(result).not.toBe(rows);
		expect(result).toEqual(rows);
	});
});