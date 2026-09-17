/**
 * Per-column row filtering for the measuring grid.
 *
 * Each header column gets a search box; the grid keeps only the rows whose text in
 * every active column contains what was typed. The matches are case-insensitive so a
 * filter works the same whether the operator types "a" or "A", and a column with an
 * empty filter never restricts. Pure, so the rules can be tested without a DOM.
 */
import type { DetailRow } from "../../../electron/preload";

/** The grid columns a search box can filter on. */
export type FilterKey = "idx" | "item" | "skin" | "grade" | "feetage" | "size" | "rate" | "net";

export type RowFilters = Partial<Record<FilterKey, string>>;

/** The readable text a row offers to a column's filter. */
export function rowSearchText(row: DetailRow, key: FilterKey): string {
	switch (key) {
		case "idx":
			return String(row.idx);
		case "item":
			return `${row.item_code ?? ""} ${row.item_name ?? ""}`.trim();
		case "skin":
			return row.skin_type ?? "";
		case "grade":
			return row.grade ?? "";
		case "feetage":
			return row.feetage ? String(row.feetage) : "";
		case "size":
			return row.size ?? "";
		case "rate":
			return row.rate ? String(row.rate) : "";
		case "net":
			return row.net_amount ? String(row.net_amount) : "";
	}
}

/**
 * The rows matching every non-empty filter.
 *
 * Filters are ANDed: once a column has text, only the rows that satisfy it and every
 * other active filter survive. Untouched filters (blank entries) never restrict.
 */
export function filterRows(rows: readonly DetailRow[], filters: RowFilters): DetailRow[] {
	const needle = (key: FilterKey): string => (filters[key] ?? "").trim().toLowerCase();
	const active = (Object.keys(filters) as FilterKey[]).filter((key) => needle(key) !== "");

	if (!active.length) return rows.slice();

	return rows.filter((row) => active.every((key) => rowSearchText(row, key).toLowerCase().includes(needle(key))));
}