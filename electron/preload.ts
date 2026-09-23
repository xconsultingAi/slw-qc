/**
 * The only bridge between the sandboxed renderer and the station.
 *
 * `contextIsolation` is on and `nodeIntegration` off, so the renderer reaches the
 * database, the filesystem and the operator's credentials through exactly these methods
 * and nothing else.
 *
 * The renderer imports these types directly from this file, so the two processes cannot
 * drift apart without the typecheck noticing.
 */
import { contextBridge, ipcRenderer } from "electron";

import type { Envelope } from "./ipc";
import type { Checklist, ChecklistState, DetailRow, RowPatch } from "./db/repositories/checklists";
import type { InwardOption } from "./db/repositories/masters";
import type { OutboxRow, OutboxState } from "./db/repositories/outbox";
import type { SummaryRow } from "./domain/summary";
import type { RowProblem } from "./domain/validation";
import type { SyncStatus } from "./sync/engine";

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
	const result = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>;
	if (!result.ok) throw new Error(result.error);
	return result.data;
}

export interface Session {
	user: string;
	fullName: string;
	roles: string[];
	offline: boolean;
}

export interface ReferenceData {
	grades: string[];
	/** False when the operator lacks permlevel-1 read: hide Touch Rate and Net Amount. */
	ratesVisible: boolean;
	warnings: {
		overlaps: { skin_type: string; a: string; b: string }[];
		gaps: { skin_type: string; from: number; to: number }[];
	};
	employees: { name: string; employee_name: string | null }[];
}

export interface QcApi {
	auth: {
		signIn(baseUrl: string, username: string, password: string): Promise<Session>;
		signOut(): Promise<void>;
		session(): Promise<Session | null>;
	};
	masters: {
		inwards(): Promise<InwardOption[]>;
		reference(): Promise<ReferenceData>;
	};
	checklist: {
		list(state?: ChecklistState): Promise<Omit<Checklist, "rows" | "selectors" | "measurers">[]>;
		create(inwardNo: string): Promise<Checklist>;
		load(localName: string): Promise<Checklist | null>;
		saveRows(localName: string, patches: RowPatch[]): Promise<{ updated: number; grand_total: number }>;
		appendRow(localName: string): Promise<Checklist | null>;
		removeRow(localName: string, id: number): Promise<Checklist | null>;
		updateHeader(
			localName: string,
			patch: { date?: string; addless?: number; selectors?: string[]; measurers?: string[] }
		): Promise<Checklist | null>;
		returnPieces(localName: string, count: number): Promise<number>;
		validate(localName: string): Promise<RowProblem[]>;
		summary(localName: string): Promise<SummaryRow[]>;
		confirm(localName: string): Promise<{ ok: boolean; problems: RowProblem[] }>;
	};
	inward: {
		updateQty(
			inwardNo: string,
			addless: number,
			grnType?: string
		): Promise<{ no_pieces: number; total_qty: number }>;
	};
	sync: {
		status(): Promise<SyncStatus>;
		pull(): Promise<void>;
		push(): Promise<void>;
	};
	queue: {
		list(state?: OutboxState): Promise<OutboxRow[]>;
		counts(): Promise<Record<OutboxState, number>>;
		retry(offlineUuid: string): Promise<void>;
	};
}

const api: QcApi = {
	auth: {
		signIn: (baseUrl, username, password) => invoke("auth:sign-in", baseUrl, username, password),
		signOut: () => invoke("auth:sign-out"),
		session: () => invoke("auth:session"),
	},
	masters: {
		inwards: () => invoke("masters:inwards"),
		reference: () => invoke("masters:reference"),
	},
	checklist: {
		list: (state) => invoke("checklist:list", state),
		create: (inwardNo) => invoke("checklist:create", inwardNo),
		load: (localName) => invoke("checklist:load", localName),
		saveRows: (localName, patches) => invoke("checklist:save-rows", localName, patches),
		appendRow: (localName) => invoke("checklist:append-row", localName),
		removeRow: (localName, id) => invoke("checklist:remove-row", localName, id),
		updateHeader: (localName, patch) => invoke("checklist:update-header", localName, patch),
		returnPieces: (localName, count) => invoke("checklist:return-pieces", localName, count),
		validate: (localName) => invoke("checklist:validate", localName),
		summary: (localName) => invoke("checklist:summary", localName),
		confirm: (localName) => invoke("checklist:confirm", localName),
	},
	inward: {
		updateQty: (inwardNo, addless, grnType) => invoke("inward:update-qty", inwardNo, addless, grnType),
	},
	sync: {
		status: () => invoke("sync:status"),
		pull: () => invoke("sync:pull"),
		push: () => invoke("sync:push"),
	},
	queue: {
		list: (state) => invoke("queue:list", state),
		counts: () => invoke("queue:counts"),
		retry: (offlineUuid) => invoke("queue:retry", offlineUuid),
	},
};

contextBridge.exposeInMainWorld("qc", api);

export type { Checklist, ChecklistState, DetailRow, InwardOption, OutboxRow, RowPatch, RowProblem, SummaryRow, SyncStatus };

declare global {
	interface Window {
		qc: QcApi;
	}
}
