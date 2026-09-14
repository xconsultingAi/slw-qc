/**
 * Master mirror: writes what `slw.api.qc_desktop.pull` returns, and builds the
 * in-memory indexes the grid resolves against.
 *
 * The whole point of mirroring is that a feetage keystroke never waits on the network.
 * The masters are small - grades in the tens, size bands in the hundreds, rate combos
 * in the low thousands - so the entire size and rate lookup is held in memory while a
 * checklist is open and resolution costs a Map hit rather than two round trips.
 */
import { sql, type Db } from "../connection";
import { buildRateIndex, type RateIndex, type TouchRateDoc, type TouchSizeDetail } from "../../domain/rates";
import { buildSizeIndex, findGaps, findOverlaps, type SizeIndex, type SkinTypeRange } from "../../domain/sizing";

export interface PullDoctypeResult {
	permitted: boolean;
	rows: Record<string, unknown>[];
	children: Record<string, Record<string, unknown>[]>;
	cursor: { modified: string; name: string } | null;
	has_more: boolean;
}

export interface PullResult {
	doctypes: Record<string, PullDoctypeResult>;
	rates_visible: boolean;
	server_time: string;
}

/** Doctype to local table and the columns copied across, in order. */
const MASTER_TABLES: Record<string, { table: string; columns: string[] }> = {
	Item: {
		table: "items",
		columns: ["name", "item_name", "skin_type", "has_variants", "is_stock_item", "disabled", "modified"],
	},
	Grade: { table: "grades", columns: ["name", "grade", "modified"] },
	"Skin Type": { table: "skin_types", columns: ["name", "skin_type", "item_template", "modified"] },
	"Skin Type Range": {
		table: "skin_type_ranges",
		columns: ["name", "skin_type", "range_name", "status", "min_range", "max_range", "modified"],
	},
	Employee: { table: "employees", columns: ["name", "employee_name", "status", "modified"] },
	"Tounch Rate": {
		table: "touch_rates",
		columns: ["name", "skin_type", "grade", "entry_date", "creation", "modified"],
	},
	"Inward Raw Hide": {
		table: "inward_raw_hides",
		columns: ["name", "vendor", "vendor_name", "date", "status", "reference_no", "total_qty", "modified"],
	},
};

const CHILD_TABLES: Record<string, { table: string; columns: string[]; parentColumn: string }> = {
	tounch_size_rate: {
		table: "touch_size_details",
		columns: ["name", "parent", "idx", "size", "size_feetage", "tounch_rate"],
		parentColumn: "parent",
	},
	raw_hide_details: {
		table: "inward_raw_hide_details",
		columns: ["name", "parent", "idx", "item_code", "item_name", "skin_type", "grade", "no_pieces"],
		parentColumn: "parent",
	},
};

function upsert(db: Db, table: string, columns: string[], rows: Record<string, unknown>[]): number {
	if (!rows.length) return 0;

	const placeholders = columns.map(() => "?").join(", ");
	const updates = columns
		.filter((column) => column !== "name")
		.map((column) => `${column} = excluded.${column}`)
		.join(", ");

	const statement = sql(db,
		`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})
		 ON CONFLICT(name) DO UPDATE SET ${updates}`
	);

	for (const row of rows) {
		statement.run(
			columns.map((column) => {
				const value = row[column];
				if (value === undefined || value === null) return null;
				// SQLite has no boolean; Frappe's Check fields arrive as 0/1 already, but a
				// JSON round trip can turn them into true/false.
				if (typeof value === "boolean") return value ? 1 : 0;
				return value as string | number;
			})
		);
	}

	return rows.length;
}

/**
 * Apply one pull response.
 *
 * All of it lands in a single transaction, so a pull interrupted half way leaves the
 * mirror on the previous cursor rather than in a state where a parent has been updated
 * and its children have not.
 */
export function applyPullResult(db: Db, result: PullResult): Record<string, number> {
	const counts: Record<string, number> = {};

	db.transaction(() => {
		for (const [doctype, payload] of Object.entries(result.doctypes)) {
			const spec = MASTER_TABLES[doctype];
			if (!spec) continue;

			if (!payload.permitted) {
				sql(db,
					`INSERT INTO sync_cursor (doctype, permitted, last_pull_at)
					 VALUES (?, 0, datetime('now'))
					 ON CONFLICT(doctype) DO UPDATE SET permitted = 0, last_pull_at = datetime('now')`
				).run(doctype);
				counts[doctype] = 0;
				continue;
			}

			counts[doctype] = upsert(db, spec.table, spec.columns, payload.rows);

			for (const [field, childRows] of Object.entries(payload.children ?? {})) {
				const childSpec = CHILD_TABLES[field];
				if (!childSpec) continue;

				// Children arrive as the complete set for the parents in this page, so the
				// old set is cleared first. Otherwise a size band removed from a Tounch Rate
				// would linger and keep pricing rows the server no longer prices.
				const parents = payload.rows.map((row) => row.name as string);
				if (parents.length) {
					const holes = parents.map(() => "?").join(", ");
					sql(db,
						`DELETE FROM ${childSpec.table} WHERE ${childSpec.parentColumn} IN (${holes})`
					).run(parents);
				}

				upsert(db, childSpec.table, childSpec.columns, childRows);
			}

			if (payload.cursor) {
				sql(db,
					`INSERT INTO sync_cursor (doctype, modified, name, permitted, last_pull_at)
					 VALUES (?, ?, ?, 1, datetime('now'))
					 ON CONFLICT(doctype) DO UPDATE SET
					   modified = excluded.modified, name = excluded.name,
					   permitted = 1, last_pull_at = datetime('now')`
				).run(doctype, payload.cursor.modified, payload.cursor.name);
			}
		}

		sql(db,
			`INSERT INTO meta (key, value) VALUES ('rates_visible', ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
		).run(result.rates_visible ? "1" : "0");
	})();

	return counts;
}

export function readCursors(db: Db): Record<string, { modified: string; name: string }> {
	const cursors: Record<string, { modified: string; name: string }> = {};
	const rows = sql(db, "SELECT doctype, modified, name FROM sync_cursor WHERE modified IS NOT NULL")
		.all() as { doctype: string; modified: string; name: string }[];

	for (const row of rows) cursors[row.doctype] = { modified: row.modified, name: row.name };
	return cursors;
}

export interface MasterIndexes {
	sizeIndex: SizeIndex;
	rateIndex: RateIndex;
	grades: string[];
	skinTypeByItem: Map<string, string | null>;
	ratesVisible: boolean;
	employees: { name: string; employee_name: string | null }[];
	/** Data problems worth showing the operator before a shift, not during one. */
	warnings: { overlaps: ReturnType<typeof findOverlaps>; gaps: ReturnType<typeof findGaps> };
}

/** Load every index a checklist screen needs, in one pass. */
export function loadMasterIndexes(db: Db): MasterIndexes {
	const ranges = sql(db, "SELECT range_name, skin_type, min_range, max_range, status FROM skin_type_ranges")
		.all() as SkinTypeRange[];

	const rateDocs = sql(db, "SELECT name, skin_type, grade, entry_date, creation FROM touch_rates")
		.all() as TouchRateDoc[];

	const sizeDetails = sql(db, "SELECT parent, size, tounch_rate FROM touch_size_details")
		.all() as TouchSizeDetail[];

	const grades = (sql(db, "SELECT name FROM grades ORDER BY name").all() as { name: string }[]).map(
		(row) => row.name
	);

	const skinTypeByItem = new Map<string, string | null>();
	for (const row of sql(db, "SELECT name, skin_type FROM items").all() as {
		name: string;
		skin_type: string | null;
	}[]) {
		skinTypeByItem.set(row.name, row.skin_type);
	}

	const ratesVisible =
		(sql(db, "SELECT value FROM meta WHERE key = 'rates_visible'").get() as
			| { value: string }
			| undefined)?.value === "1";

	const employees = sql(db, "SELECT name, employee_name FROM employees ORDER BY employee_name")
		.all() as { name: string; employee_name: string | null }[];

	const sizeIndex = buildSizeIndex(ranges);

	return {
		sizeIndex,
		rateIndex: buildRateIndex(rateDocs, sizeDetails),
		grades,
		skinTypeByItem,
		ratesVisible,
		employees,
		warnings: { overlaps: findOverlaps(sizeIndex), gaps: findGaps(sizeIndex) },
	};
}

export interface InwardOption {
	name: string;
	vendor: string | null;
	vendor_name: string | null;
	reference_no: string | null;
	date: string | null;
	status: string | null;
	total_qty: number;
	local_checklist: string | null;
	local_state: string | null;
}

/**
 * GRNs a checklist can still be started against.
 *
 * Mirrors the desk form's `set_query` on `inward_no` (submitted, not Complete), and
 * additionally reports any local checklist already covering the GRN. Without that, an
 * operator whose push has not yet gone through can start the same GRN twice.
 */
export function listOpenInwards(db: Db): InwardOption[] {
	return sql(db,
			`SELECT irh.name, irh.vendor, irh.vendor_name, irh.reference_no, irh.date, irh.status, irh.total_qty,
			        qc.local_name AS local_checklist, qc.state AS local_state
			   FROM inward_raw_hides irh
			   LEFT JOIN qc_check_lists qc ON qc.inward_no = irh.name AND qc.state != 'failed'
			  WHERE COALESCE(irh.status, '') NOT IN ('Complete', 'Draft')
			  ORDER BY irh.date DESC, irh.name DESC`
		)
		.all() as InwardOption[];
}
