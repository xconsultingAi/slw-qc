/**
 * IPC surface.
 *
 * Every handler returns a result envelope rather than throwing across the bridge, so a
 * failure arrives at the renderer as a message it can show rather than an opaque
 * "Error invoking remote method". The preload unwraps it back into a thrown Error.
 *
 * The renderer is sandboxed and has no database, no filesystem and no credentials. It
 * asks for what it needs and gets plain data back.
 */
import { ipcMain } from "electron";

import type { Db } from "../db/connection";
import type { SyncEngine } from "../sync/engine";
import type { ErpnextClient } from "../sync/erpnext";
import {
	appendRow,
	confirm,
	createFromInward,
	listChecklists,
	loadChecklist,
	removeRow,
	saveRows,
	setReturnPieces,
	updateHeader,
	type RowPatch,
} from "../db/repositories/checklists";
import { listOpenInwards, loadMasterIndexes } from "../db/repositories/masters";
import { listQueue, queueCounts, retryNow } from "../db/repositories/outbox";
import { groupChecklistRows } from "../domain/summary";
import { validateForConfirm } from "../domain/validation";

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

export interface AppContext {
	db: () => Db;
	client: () => ErpnextClient;
	engine: () => SyncEngine;
	session: () => { user: string; fullName: string; roles: string[]; offline: boolean } | null;
	signIn: (baseUrl: string, username: string, password: string) => Promise<unknown>;
	signOut: () => void;
	baseUrl: () => string | null;
}

function handle<T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T): void {
	ipcMain.handle(channel, async (_event, ...args) => {
		try {
			return { ok: true as const, data: await fn(...args) };
		} catch (error) {
			return { ok: false as const, error: (error as Error).message };
		}
	});
}

export function registerIpc(context: AppContext): void {
	// --- session ---
	handle("auth:sign-in", (baseUrl, username, password) =>
		context.signIn(baseUrl as string, username as string, password as string)
	);
	handle("auth:sign-out", () => context.signOut());
	handle("auth:session", () => context.session());

	// --- masters ---
	handle("masters:inwards", () => listOpenInwards(context.db()));
	handle("masters:reference", () => {
		const indexes = loadMasterIndexes(context.db());
		// Maps and Map-backed indexes do not survive structured cloning usefully, so the
		// renderer gets only what it draws with: the grade list, the rate visibility flag
		// and any master-data problems worth warning about.
		return {
			grades: indexes.grades,
			ratesVisible: indexes.ratesVisible,
			warnings: indexes.warnings,
			employees: indexes.employees,
		};
	});

	// --- checklists ---
	handle("checklist:list", (state) =>
		listChecklists(context.db(), state as undefined | Parameters<typeof listChecklists>[1])
	);
	handle("checklist:create", (inwardNo) =>
		createFromInward(context.db(), inwardNo as string, context.session()?.user ?? "unknown")
	);
	handle("checklist:load", (localName) => loadChecklist(context.db(), localName as string));

	handle("checklist:save-rows", (localName, patches) =>
		saveRows(
			context.db(),
			localName as string,
			patches as RowPatch[],
			loadMasterIndexes(context.db())
		)
	);

	handle("checklist:update-header", (localName, patch) => {
		updateHeader(context.db(), localName as string, patch as Parameters<typeof updateHeader>[2]);
		return loadChecklist(context.db(), localName as string);
	});

	handle("checklist:return-pieces", (localName, count) =>
		setReturnPieces(context.db(), localName as string, count as number)
	);

	handle("checklist:append-row", (localName) => appendRow(context.db(), localName as string));

	handle("checklist:remove-row", (localName, id) =>
		removeRow(context.db(), localName as string, id as number)
	);

	handle("checklist:validate", (localName) => {
		const list = loadChecklist(context.db(), localName as string);
		return list ? validateForConfirm(list.rows) : [];
	});

	handle("checklist:summary", (localName) => {
		const list = loadChecklist(context.db(), localName as string);
		return list ? groupChecklistRows(list.rows) : [];
	});

	handle("checklist:confirm", async (localName) => {
		const result = confirm(context.db(), localName as string);
		// Push straight away rather than waiting for the next tick: the operator has just
		// pressed Confirm and is watching for it to land.
		if (result.ok) void context.engine().pushOnce().catch(() => undefined);
		return result;
	});

	// --- inward qty, which mutates a submitted document and so needs the network ---
	handle("inward:update-qty", async (inwardNo, addless) =>
		context.client().updateInwardQty(inwardNo as string, addless as number)
	);

	// --- sync and queue ---
	handle("sync:status", () => context.engine().getStatus());
	handle("sync:pull", () => context.engine().pullOnce());
	handle("sync:push", () => context.engine().pushOnce());
	handle("queue:list", (state) => listQueue(context.db(), state as undefined | "failed"));
	handle("queue:counts", () => queueCounts(context.db()));
	handle("queue:retry", (offlineUuid) => retryNow(context.db(), offlineUuid as string));
}
