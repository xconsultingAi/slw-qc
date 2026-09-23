-- SLW QC station schema (SQLite).
--
-- One database per workstation. Nothing here is shared between stations: a QC station
-- is single-operator, which is why this is SQLite and not the MariaDB hub topology the
-- POS client needs.
--
-- Two conventions run through the whole file:
--
--   * `offline_uuid` is generated on this machine and is the identity that survives a
--     push. `erp_name` is filled in only once ERPNext has confirmed the document.
--   * Money and feetage are advisory. `QCCheckList.validate` recomputes size, rate,
--     net_amount, grand_total and the entire summary on every push, so these columns
--     exist to draw the screen, never to be the authority on a number.
--
-- The summary is deliberately absent. It is a group-by over qc_check_list_details,
-- recomputed on read, so it cannot drift from the rows it summarises.

-- --- infrastructure -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
	key        TEXT PRIMARY KEY,
	value      TEXT
);

CREATE TABLE IF NOT EXISTS patch_log (
	patch      TEXT PRIMARY KEY,
	applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cashier-style local sign-in. The password hash is bcrypt and never leaves this
-- machine; ERPNext authentication uses the API key pair in the OS keychain instead.
CREATE TABLE IF NOT EXISTS operators (
	username        TEXT PRIMARY KEY,
	full_name       TEXT,
	roles_json      TEXT NOT NULL DEFAULT '[]',
	password_hash   TEXT,
	failed_attempts INTEGER NOT NULL DEFAULT 0,
	locked_until    TEXT,
	last_login_at   TEXT,
	disabled        INTEGER NOT NULL DEFAULT 0
);

-- Keyset pull position per doctype. `permitted` records that the server withheld a
-- doctype for lack of read permission, so the UI can hide what depends on it rather
-- than showing an empty picker with no explanation.
CREATE TABLE IF NOT EXISTS sync_cursor (
	doctype      TEXT PRIMARY KEY,
	modified     TEXT,
	name         TEXT,
	permitted    INTEGER NOT NULL DEFAULT 1,
	last_pull_at TEXT
);

CREATE TABLE IF NOT EXISTS error_log (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	at         TEXT NOT NULL DEFAULT (datetime('now')),
	context    TEXT,
	message    TEXT,
	detail     TEXT
);

-- --- master mirrors -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS items (
	name          TEXT PRIMARY KEY,
	item_name     TEXT,
	skin_type     TEXT,
	has_variants  INTEGER NOT NULL DEFAULT 0,
	is_stock_item INTEGER NOT NULL DEFAULT 0,
	disabled      INTEGER NOT NULL DEFAULT 0,
	modified      TEXT
);
CREATE INDEX IF NOT EXISTS ix_items_skin_type ON items (skin_type);

CREATE TABLE IF NOT EXISTS grades (
	name     TEXT PRIMARY KEY,
	grade    TEXT,
	modified TEXT
);

CREATE TABLE IF NOT EXISTS skin_types (
	name          TEXT PRIMARY KEY,
	skin_type     TEXT,
	item_template TEXT,
	modified      TEXT
);

CREATE TABLE IF NOT EXISTS skin_type_ranges (
	name       TEXT PRIMARY KEY,
	skin_type  TEXT NOT NULL,
	range_name TEXT NOT NULL,
	status     TEXT,
	min_range  REAL NOT NULL DEFAULT 0,
	max_range  REAL NOT NULL DEFAULT 0,
	modified   TEXT
);
CREATE INDEX IF NOT EXISTS ix_ranges_lookup ON skin_type_ranges (skin_type, status, min_range, max_range);

CREATE TABLE IF NOT EXISTS employees (
	name          TEXT PRIMARY KEY,
	employee_name TEXT,
	status        TEXT,
	modified      TEXT
);

CREATE TABLE IF NOT EXISTS touch_rates (
	name       TEXT PRIMARY KEY,
	skin_type  TEXT NOT NULL,
	grade      TEXT NOT NULL,
	entry_date TEXT,
	creation   TEXT,
	modified   TEXT
);
CREATE INDEX IF NOT EXISTS ix_touch_rates_pair ON touch_rates (skin_type, grade, entry_date DESC, creation DESC);

-- `tounch_rate` is NULL when the operator lacks permlevel-1 read on Tounch Rate. That
-- is a legitimate state, not missing data: only System Manager may see pricing.
CREATE TABLE IF NOT EXISTS touch_size_details (
	name        TEXT PRIMARY KEY,
	parent      TEXT NOT NULL,
	idx         INTEGER NOT NULL DEFAULT 0,
	size        TEXT,
	size_feetage REAL,
	tounch_rate REAL
);
CREATE INDEX IF NOT EXISTS ix_touch_size_parent ON touch_size_details (parent);

CREATE TABLE IF NOT EXISTS inward_raw_hides (
	name         TEXT PRIMARY KEY,
	vendor       TEXT,
	vendor_name  TEXT,
	date         TEXT,
	status       TEXT,
	reference_no TEXT,
	total_qty    INTEGER NOT NULL DEFAULT 0,
	modified     TEXT
);
CREATE INDEX IF NOT EXISTS ix_irh_status ON inward_raw_hides (status);

CREATE TABLE IF NOT EXISTS inward_raw_hide_details (
	name      TEXT PRIMARY KEY,
	parent    TEXT NOT NULL,
	idx       INTEGER NOT NULL DEFAULT 0,
	item_code TEXT,
	item_name TEXT,
	skin_type TEXT,
	grade     TEXT,
	no_pieces INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_irh_detail_parent ON inward_raw_hide_details (parent);

-- Merges are their own mirror, not a flag on Inward Raw Hide: Merge Inward Raw Hide is
-- a separate doctype with its own child table, and every submitted merge is offered to
-- the QC terminal exactly like an inward GRN. `grn_type` on qc_check_lists (below) says
-- which mirror a checklist was built from, so the operator's Update-GRN-qty and the
-- server's status flip target the right doctype.
CREATE TABLE IF NOT EXISTS merge_inward_raw_hides (
	name         TEXT PRIMARY KEY,
	vendor       TEXT,
	vendor_name  TEXT,
	date         TEXT,
	status       TEXT,
	reference_no TEXT,
	total_qty    INTEGER NOT NULL DEFAULT 0,
	modified     TEXT
);
CREATE INDEX IF NOT EXISTS ix_irh_status_merge ON merge_inward_raw_hides (status);

CREATE TABLE IF NOT EXISTS merge_inward_raw_hide_details (
	name      TEXT PRIMARY KEY,
	parent    TEXT NOT NULL,
	idx       INTEGER NOT NULL DEFAULT 0,
	item_code TEXT,
	item_name TEXT,
	skin_type TEXT,
	grade     TEXT,
	no_pieces INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_irh_detail_parent_merge ON merge_inward_raw_hide_details (parent);

-- --- local documents ----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS qc_check_lists (
	local_name    TEXT PRIMARY KEY,
	offline_uuid  TEXT NOT NULL UNIQUE,
	inward_no     TEXT,
	grn_type      TEXT NOT NULL DEFAULT 'Inward Raw Hide'
	              CHECK (grn_type IN ('Inward Raw Hide', 'Merge Inward Raw Hide')),
	vendor        TEXT,
	vendor_name   TEXT,
	date          TEXT,
	inward_date   TEXT,
	addless       INTEGER NOT NULL DEFAULT 0,
	return_pieces INTEGER NOT NULL DEFAULT 0,
	grand_total   REAL NOT NULL DEFAULT 0,
	state         TEXT NOT NULL DEFAULT 'draft'
	              CHECK (state IN ('draft', 'queued', 'sent', 'confirmed', 'failed')),
	erp_name      TEXT,
	created_by    TEXT NOT NULL,
	created_at    TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_checklists_state ON qc_check_lists (state);
CREATE INDEX IF NOT EXISTS ix_checklists_inward ON qc_check_lists (inward_no);

CREATE TABLE IF NOT EXISTS qc_check_list_details (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	parent     TEXT NOT NULL REFERENCES qc_check_lists (local_name) ON DELETE CASCADE,
	idx        INTEGER NOT NULL,
	item_code  TEXT,
	item_name  TEXT,
	skin_type  TEXT,
	grade      TEXT,
	size       TEXT,
	status     TEXT CHECK (status IS NULL OR status IN ('Accepted', 'Rejected')),
	feetage    REAL NOT NULL DEFAULT 0,
	no_pieces  INTEGER NOT NULL DEFAULT 1,
	rate       REAL NOT NULL DEFAULT 0,
	net_amount REAL NOT NULL DEFAULT 0
);
-- Not UNIQUE(parent, idx): trimming rows renumbers a whole block, and a unique
-- constraint would collide part-way through that update even though the end state is
-- valid.
CREATE INDEX IF NOT EXISTS ix_details_parent_idx ON qc_check_list_details (parent, idx);

-- Both Selector and Measurer are Table MultiSelect fields over the same child doctype,
-- so one table with a `kind` discriminator mirrors them without duplication.
CREATE TABLE IF NOT EXISTS qc_check_list_persons (
	id       INTEGER PRIMARY KEY AUTOINCREMENT,
	parent   TEXT NOT NULL REFERENCES qc_check_lists (local_name) ON DELETE CASCADE,
	kind     TEXT NOT NULL CHECK (kind IN ('selector', 'measurer')),
	employee TEXT NOT NULL,
	idx      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_persons_parent ON qc_check_list_persons (parent, kind);

-- --- outbox -------------------------------------------------------------------------

-- A confirmed checklist and its outbox row are written in one transaction, so a
-- document can never reach 'queued' without something queued to send it.
CREATE TABLE IF NOT EXISTS outbox (
	id              INTEGER PRIMARY KEY AUTOINCREMENT,
	offline_uuid    TEXT NOT NULL UNIQUE,
	local_name      TEXT NOT NULL,
	payload_json    TEXT NOT NULL,
	state           TEXT NOT NULL DEFAULT 'queued'
	                CHECK (state IN ('draft', 'queued', 'sent', 'confirmed', 'failed')),
	attempts        INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TEXT,
	last_error      TEXT,
	erp_name        TEXT,
	created_by      TEXT NOT NULL,
	created_at      TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_outbox_due ON outbox (state, next_attempt_at);
