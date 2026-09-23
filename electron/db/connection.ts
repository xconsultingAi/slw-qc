/**
 * SQLite connection and migrations.
 *
 * better-sqlite3 is synchronous and in-process. That is the whole reason it is here:
 * the grid autosaves as the operator types, and a synchronous sub-millisecond write
 * cannot introduce the await-shaped stutter that a network or an async driver can. An
 * entire 2,000-row flush is a few milliseconds inside one transaction.
 */
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";

export type Db = Database.Database;

let db: Db | null = null;

/** Ordered, run once each, recorded in `patch_log`. Empty while the schema is unreleased. */
export interface Patch {
	id: string;
	run: (db: Db) => void;
}

export const PATCHES: Patch[] = [];

// The schema is applied with CREATE ... IF NOT EXISTS, so an existing station never
// gains the newer columns. PATCHES close that gap, one guarded ALTER per release. The
// guard matters: a fresh install already runs the current schema, so the ALTER must
// turn into a no-op rather than dying on a duplicate column.
PATCHES.push({
	id: "qc_check_lists.grn_type",
	run(db) {
		const cols = new Set(
			(db.prepare("PRAGMA table_info(qc_check_lists)").all() as { name: string }[]).map((c) => c.name)
		);
		if (!cols.has("grn_type")) {
			db.exec("ALTER TABLE qc_check_lists ADD COLUMN grn_type TEXT NOT NULL DEFAULT 'Inward Raw Hide'");
		}
	},
});

export function openDatabase(filePath: string, schemaSql: string): Db {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });

	// Close whatever was open first. A replaced-but-unclosed handle keeps its WAL lock
	// and, being a native object, runs its destructor whenever the collector gets to it -
	// which in a short-lived process can be after the V8 environment has gone, aborting
	// the process outright.
	closeDatabase();

	const handle = new Database(filePath);

	// WAL lets the autosave flush proceed without blocking a read that is drawing the
	// grid. NORMAL trades an fsync per commit for one per checkpoint: on power loss the
	// last few milliseconds of typing may be lost, which is a fair price for never
	// stalling the keyboard, and the document is still a local draft at that point.
	handle.pragma("journal_mode = WAL");
	handle.pragma("synchronous = NORMAL");
	// Child rows must not outlive the checklist they belong to; SQLite leaves this off
	// unless asked, per connection.
	handle.pragma("foreign_keys = ON");
	handle.pragma("busy_timeout = 5000");

	migrate(handle, schemaSql);

	db = handle;
	return handle;
}

export function migrate(handle: Db, schemaSql: string): void {
	// Every statement is CREATE ... IF NOT EXISTS, so applying the schema to an existing
	// database is a no-op and the fresh-install and upgrade paths stay identical.
	handle.exec(schemaSql);

	const applied = new Set(
		handle
			.prepare("SELECT patch FROM patch_log")
			.all()
			.map((row) => (row as { patch: string }).patch)
	);

	const record = handle.prepare("INSERT INTO patch_log (patch) VALUES (?)");

	for (const patch of PATCHES) {
		if (applied.has(patch.id)) continue;
		handle.transaction(() => {
			patch.run(handle);
			record.run(patch.id);
		})();
	}

	handle
		.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_bootstrapped_at', datetime('now'))")
		.run();
}

/**
 * Prepared-statement cache, keyed by SQL text.
 *
 * Two reasons, and both matter. Preparing a statement costs a parse and a plan, and the
 * grid's autosave runs the same handful of statements thousands of times in a shift.
 * And every `db.prepare()` mints a native Statement object: discard those at that rate
 * and their finalisers eventually run against a torn-down V8 environment, which aborts
 * the process ("RemoveEnvironmentCleanupHook: Assertion (env) != nullptr"). Preparing
 * once and holding the reference avoids both.
 */
const statementCache = new WeakMap<Db, Map<string, Statement>>();

export function sql(db: Db, text: string): Statement {
	let cache = statementCache.get(db);
	if (!cache) {
		cache = new Map();
		statementCache.set(db, cache);
	}

	let statement = cache.get(text);
	if (!statement) {
		statement = db.prepare(text);
		cache.set(text, statement);
	}
	return statement;
}

export function getDb(): Db {
	if (!db) throw new Error("Database not opened. Call openDatabase first.");
	return db;
}

export function setDb(handle: Db | null): void {
	db = handle;
}

export function closeDatabase(): void {
	db?.close();
	db = null;
}

/**
 * Run `fn` in a transaction.
 *
 * better-sqlite3 transactions are synchronous by design, so `fn` must not be async -
 * an await inside would commit before the awaited work finished. Confirming a
 * checklist relies on this: the document, its rows and its outbox entry are one atomic
 * write, and a document can never reach 'queued' with nothing queued to send it.
 */
export function transaction<T>(fn: (db: Db) => T): T {
	const handle = getDb();
	return handle.transaction(fn)(handle);
}
