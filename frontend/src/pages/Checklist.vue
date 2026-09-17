<script setup lang="ts">
/**
 * The measuring screen.
 *
 * Every commit follows the same path: write locally, get the re-resolved rows back,
 * repaint. The main process resolves size and rate from in-memory indexes, so the round
 * trip is an IPC call to the same machine and never touches the network. What the
 * operator sees is therefore never waiting on ERPNext.
 */
import { computed, nextTick, onMounted, ref } from "vue";

import QcGrid from "../components/QcGrid.vue";
import { fillDownTargets } from "../composables/grades";
import { useSession } from "../stores/session";
import type { Checklist, RowProblem, SummaryRow } from "../../../electron/preload";

const props = defineProps<{ localName: string }>();

const store = useSession();

const doc = ref<Checklist | null>(null);
const summary = ref<SummaryRow[]>([]);
const problems = ref<RowProblem[]>([]);
const notice = ref<string | null>(null);
const error = ref<string | null>(null);
const confirming = ref(false);
const personsRow = ref<HTMLElement | null>(null);
/** The QC people on this document, persisted through `updateHeader`. */
const selectors = ref<string[]>([]);
const measurers = ref<string[]>([]);
const personPicker = ref<"selector" | "measurer" | null>(null);
const personSearch = ref("");
const personSearchInput = ref<HTMLInputElement | null>(null);
const employees = computed(() => store.reference?.employees ?? []);

/**
 * The employee list narrowed by what has been typed. Matches against both the employee
 * name and the readable display name, case-insensitively, the way the desk form's Link
 * multi-select suggests values.
 */
const filteredEmployees = computed(() => {
	const needle = personSearch.value.trim().toLowerCase();
	if (!needle) return employees.value;
	return employees.value.filter(
		(employee) =>
			employee.name.toLowerCase().includes(needle) ||
			(employee.employee_name ?? "").toLowerCase().includes(needle)
	);
});

/** Open a person list, reset its search, and put the caret in the box. */
function togglePersonPicker(kind: "selector" | "measurer"): void {
	personPicker.value = personPicker.value === kind ? null : kind;
	personSearch.value = "";
	if (personPicker.value) void nextTick(() => personSearchInput.value?.focus());
}
/** Set aside so a fill-down can be undone; the desk form offers no way back. */
const undo = ref<{ label: string; patches: { id: number; grade: string | null }[] } | null>(null);

const readonly = computed(() => !!doc.value && doc.value.state !== "draft" && doc.value.state !== "failed");
const problemRows = computed(() => new Set(problems.value.map((problem) => problem.idx)));
const total = computed(() => doc.value?.grand_total ?? 0);

async function load(): Promise<void> {
	doc.value = await window.qc.checklist.load(props.localName);
	await refreshDerived();
	syncPersons();
}

async function refreshDerived(): Promise<void> {
	summary.value = await window.qc.checklist.summary(props.localName);
	problems.value = await window.qc.checklist.validate(props.localName);
}

function syncPersons(): void {
	selectors.value = doc.value?.selectors ?? [];
	measurers.value = doc.value?.measurers ?? [];
}

/** Persist both person lists in one call; the local DB is what the push reads. */
async function commitPersons(): Promise<void> {
	if (!doc.value) return;
	try {
		await window.qc.checklist.updateHeader(doc.value.local_name, {
			// Vue refs are reactive Proxies, and Electron cannot structured-clone a Proxy
			// across the IPC boundary — it throws "An object could not be cloned". Plain
			// copies go across.
			selectors: [...selectors.value],
			measurers: [...measurers.value],
		});
	} catch (caught) {
		error.value = (caught as Error).message;
	}
}

function togglePerson(kind: "selector" | "measurer", name: string): void {
	const target = kind === "selector" ? selectors : measurers;
	const index = target.value.indexOf(name);
	if (index === -1) target.value.push(name);
	else target.value.splice(index, 1);
	void commitPersons();
}

function personName(name: string): string {
	return employees.value.find((row) => row.name === name)?.employee_name ?? name;
}

/** Close the person lists when the operator clicks anywhere else. */
function onDocumentClick(event: MouseEvent): void {
	if (!personPicker.value) return;
	if (personsRow.value && !personsRow.value.contains(event.target as Node)) {
		personPicker.value = null;
	}
}

async function apply(patches: { id: number; grade?: string | null; feetage?: number }[]): Promise<void> {
	if (!patches.length) return;
	error.value = null;
	try {
		await window.qc.checklist.saveRows(props.localName, patches);
		await load();
	} catch (caught) {
		error.value = (caught as Error).message;
	}
}

function onCommit(payload: { id: number; field: string; value: string }): void {
	if (payload.field === "feetage") {
		// Parsed, but never corrected: an out-of-range number is kept and flagged, so a
		// measurement the operator typed cannot silently become zero.
		const parsed = Number.parseFloat(payload.value.replace(/,/g, "").trim());
		void apply([{ id: payload.id, feetage: Number.isFinite(parsed) ? parsed : 0 }]);
	} else if (payload.field === "grade") {
		void setGrade(payload.id, payload.value || null);
	}
}

/** The grid refused a grade that is not on the master. Say so where the operator looks. */
function onReject(message: string): void {
	error.value = message;
}

/**
 * The row editor saved one row: apply the Grade and Feetage to that row only.
 *
 * Deliberately NOT `setGrade`, which fills a grade into every row below. This is the
 * single-row correction path - a mis-graded hide in the middle of a run must be fixable
 * without rewriting the rows beneath it.
 */
async function onEditorSave(payload: { id: number; grade: string; feetage: string }): Promise<void> {
	const row = doc.value?.rows.find((candidate) => candidate.id === payload.id);
	if (!row) return;

	const typed = payload.grade.trim();
	const patches: { id: number; grade?: string | null; feetage?: number }[] = [];

	// A blank grade means "clear it" only when the row actually holds a grade.
	if (typed !== (row.grade ?? "")) {
		patches.push({ id: payload.id, grade: typed || null });
	}

	const parsed = Number.parseFloat(payload.feetage.replace(/,/g, "").trim());
	const value = Number.isFinite(parsed) ? parsed : 0;
	if (value !== row.feetage) {
		patches.push({ id: payload.id, feetage: value });
	}

	if (patches.length) await apply(patches);
}

/**
 * Copy the last row and append it, so a piece the GRN did not count can be measured
 * without re-exploding the GRN and throwing the shift's work away.
 */
async function addRow(): Promise<void> {
	error.value = null;
	try {
		await window.qc.checklist.appendRow(props.localName);
		await load();
	} catch (caught) {
		error.value = (caught as Error).message;
	}
}

/**
 * Set a grade and carry it down every row below, as the desk form does.
 *
 * Hides are graded in runs, so the operator picks A once and changes it only where the
 * run changes; making them choose on all 2,000 rows is the thing this replaces. Clearing
 * a grade fills nothing down - the desk form stops there too, and spreading a blank over
 * work already graded is nobody's intent.
 *
 * Both halves go in one call, so the rows repaint once rather than twice. Unlike the desk
 * form it is announced and reversible: rewriting hundreds of rows on a mis-pick is how an
 * afternoon disappears.
 */
async function setGrade(id: number, grade: string | null): Promise<void> {
	if (!doc.value) return;

	const index = doc.value.rows.findIndex((row) => row.id === id);
	if (index === -1) return;

	const below = fillDownTargets(doc.value.rows, index, grade);

	// The undo restores only the rows below. The one the operator picked on was their own
	// decision and putting it back would be undoing something they did not ask about.
	undo.value = below.length
		? {
				label: `Grade ${grade} applied to ${below.length} row(s) below`,
				patches: below.map((row) => ({ id: row.id, grade: row.grade })),
			}
		: null;
	notice.value = undo.value?.label ?? null;

	await apply([{ id, grade }, ...below.map((row) => ({ id: row.id, grade }))]);
}

async function undoFillDown(): Promise<void> {
	if (!undo.value) return;
	const patches = undo.value.patches;
	undo.value = null;
	notice.value = null;
	await apply(patches);
}

async function setReturnPieces(event: Event): Promise<void> {
	const count = Number((event.target as HTMLInputElement).value || 0);
	error.value = null;
	try {
		await window.qc.checklist.returnPieces(props.localName, count);
		await load();
	} catch (caught) {
		error.value = (caught as Error).message;
	}
}

async function confirmChecklist(): Promise<void> {
	confirming.value = true;
	error.value = null;
	personPicker.value = null;
	try {
		const result = await window.qc.checklist.confirm(props.localName);
		problems.value = result.problems;
		if (result.ok) notice.value = "Confirmed. Queued for ERPNext.";
		else error.value = `${result.problems.length} row(s) need attention before this can be confirmed.`;
		await load();
	} catch (caught) {
		error.value = (caught as Error).message;
	} finally {
		confirming.value = false;
	}
}

async function updateInwardQty(): Promise<void> {
	if (!doc.value?.inward_no) return;
	error.value = null;
	try {
		const result = await window.qc.inward.updateQty(doc.value.inward_no, doc.value.addless);
		notice.value = `Inward pieces updated to ${result.no_pieces}; total is now ${result.total_qty}.`;
	} catch (caught) {
		// This writes to a submitted document, so it is the one action that genuinely
		// cannot be done offline.
		error.value = `Could not update the GRN: ${(caught as Error).message}`;
	}
}

onMounted(() => {
	document.addEventListener("click", onDocumentClick);
	// Refresh masters (e.g. a freshly pulled employee list) without disturbing the doc.
	void store.loadReference().catch(() => undefined);
	void load();
});
</script>

<template>
	<section v-if="doc" class="page">
		<header class="head">
			<div>
				<h1>{{ doc.local_name }}<span v-if="doc.erp_name"> &rarr; {{ doc.erp_name }}</span></h1>
				<p class="sub">
					{{ doc.inward_no }} &middot; {{ doc.vendor_name ?? doc.vendor }} &middot; {{ doc.date }}
					<span class="state" :class="`state--${doc.state}`">{{ doc.state }}</span>
				</p>
			</div>

			<div class="actions">
				<label class="inline">
					Return pieces
					<input
						type="number"
						min="0"
						:value="doc.return_pieces"
						:disabled="readonly"
						@change="setReturnPieces"
					/>
				</label>
				<label class="inline">
					Add &amp; Less
					<input type="number" v-model.number="doc.addless" :disabled="readonly" />
				</label>
				<button :disabled="readonly || !doc.addless" @click="updateInwardQty">Update GRN qty</button>
				<button class="primary" :disabled="readonly || confirming" @click="confirmChecklist">
					{{ confirming ? "Confirming..." : "Confirm &amp; sync" }}
				</button>
			</div>
		</header>

		<div ref="personsRow" class="persons">
			<label class="persons__field">
				<span class="persons__label">Selector</span>
				<span class="persons__pop">
					<button
						type="button"
						class="persons__toggle"
						:disabled="readonly"
						@click.stop="togglePersonPicker('selector')"
					>
						{{ selectors.length ? selectors.map(personName).join(", ") : "Pick the selector(s)" }}
					</button>
					<ul v-if="personPicker === 'selector'" class="persons__list">
						<li class="persons__search">
							<input
								ref="personSearchInput"
								v-model="personSearch"
								type="search"
								placeholder="Search selector…"
								autocomplete="off"
								spellcheck="false"
							/>
						</li>
						<li
							v-for="employee in filteredEmployees"
							:key="employee.name"
							class="persons__item"
							:class="{ 'persons__item--on': selectors.includes(employee.name) }"
							@click.stop="togglePerson('selector', employee.name)"
						>
							{{ employee.employee_name ?? employee.name }}
						</li>
						<li v-if="!employees.length" class="persons__empty">
							No employees have synced from ERPNext yet. Pull masters first.
						</li>
						<li v-else-if="!filteredEmployees.length" class="persons__empty">
							No employee matches "{{ personSearch }}".
						</li>
					</ul>
				</span>
			</label>

			<label class="persons__field">
				<span class="persons__label">Measurer</span>
				<span class="persons__pop">
					<button
						type="button"
						class="persons__toggle"
						:disabled="readonly"
						@click.stop="togglePersonPicker('measurer')"
					>
						{{ measurers.length ? measurers.map(personName).join(", ") : "Pick the measurer(s)" }}
					</button>
					<ul v-if="personPicker === 'measurer'" class="persons__list">
						<li class="persons__search">
							<input
								v-model="personSearch"
								type="search"
								placeholder="Search measurer…"
								autocomplete="off"
								spellcheck="false"
							/>
						</li>
						<li
							v-for="employee in filteredEmployees"
							:key="employee.name"
							class="persons__item"
							:class="{ 'persons__item--on': measurers.includes(employee.name) }"
							@click.stop="togglePerson('measurer', employee.name)"
						>
							{{ employee.employee_name ?? employee.name }}
						</li>
						<li v-if="!employees.length" class="persons__empty">
							No employees have synced from ERPNext yet. Pull masters first.
						</li>
						<li v-else-if="!filteredEmployees.length" class="persons__empty">
							No employee matches "{{ personSearch }}".
						</li>
					</ul>
				</span>
			</label>
		</div>

		<p v-if="notice" class="notice">
			{{ notice }}
			<button v-if="undo" class="link" @click="undoFillDown">Undo</button>
		</p>
		<p v-if="error" class="error">{{ error }}</p>

		<div class="body">
			<QcGrid
				:rows="doc.rows"
				:grades="store.reference?.grades ?? []"
				:readonly="readonly"
				:problem-rows="problemRows"
				@commit="onCommit"
				@reject="onReject"
				@editor-save="onEditorSave"
				@append-row="addRow"
			/>

			<aside class="side">
                <h2>Summary</h2>
				<table>
					<thead>
						<tr>
							<th>Grade</th>
							<th>Skin</th>
							<th>Size</th>
							<th class="num">Pcs</th>
							<th class="num">Feet</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="(group, index) in summary" :key="index">
							<td>{{ group.grade }}</td>
							<td>{{ group.skin_type }}</td>
							<td>{{ group.size }}</td>
							<td class="num">{{ group.no_pieces }}</td>
							<td class="num">{{ group.feetage.toFixed(2) }}</td>
						</tr>
					</tbody>
				</table>

				<p v-if="store.reference?.ratesVisible" class="total">
					Grand total <strong>{{ total.toFixed(2) }}</strong>
				</p>

				<template v-if="problems.length">
					<h2>Before confirming</h2>
					<ul class="problems">
						<li v-for="(problem, index) in problems.slice(0, 25)" :key="index">{{ problem.message }}</li>
					</ul>
					<p v-if="problems.length > 25" class="muted">and {{ problems.length - 25 }} more</p>
				</template>
			</aside>
		</div>
	</section>
</template>

<style scoped>
.page {
	display: flex;
	flex-direction: column;
	min-height: 0;
	flex: 1;
	gap: 0.6rem;
}

.head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 1rem;
}

h1 {
	margin: 0;
	font-size: 1.05rem;
}

.sub {
	margin: 0.15rem 0 0;
	color: var(--muted);
	font-size: 0.85rem;
}

.state {
	margin-left: 0.5rem;
	padding: 0.05rem 0.45rem;
	border: 1px solid var(--line);
	border-radius: 999px;
	font-size: 0.72rem;
	text-transform: uppercase;
}

.state--confirmed {
	border-color: var(--good);
	color: var(--good);
}

.state--failed {
	border-color: var(--bad);
	color: var(--bad);
}

.actions {
	display: flex;
	align-items: flex-end;
	gap: 0.5rem;
}

.inline {
	display: flex;
	flex-direction: column;
	gap: 0.15rem;
	font-size: 0.75rem;
	color: var(--muted);
}

.inline input {
	width: 6rem;
}

/* Selector and Measurer are Table MultiSelect fields on the desk form; on a terminal
   they become a dropdown over the synced Employee master, persisted to the local DB. */
.persons {
	display: flex;
	gap: 0.9rem;
	flex-wrap: wrap;
}

.persons__field {
	display: flex;
	align-items: center;
	gap: 0.4rem;
	font-size: 0.82rem;
}

.persons__label {
	text-transform: uppercase;
	letter-spacing: 0.04em;
	font-size: 0.72rem;
	color: var(--muted);
}

.persons__pop {
	position: relative;
}

.persons__toggle {
	min-width: 13rem;
	padding: 0.25rem 1.6rem 0.25rem 0.6rem;
	text-align: left;
	font-size: 0.82rem;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.persons__toggle:disabled {
	opacity: 0.7;
	cursor: not-allowed;
}

.persons__toggle::after {
	content: "\25be";
	position: absolute;
	right: 0.5rem;
	top: 50%;
	transform: translateY(-50%);
	color: var(--muted);
	font-size: 0.7rem;
}

.persons__list {
	position: absolute;
	z-index: 30;
	top: 100%;
	left: 0;
	margin: 0;
	padding: 0.15rem;
	min-width: 100%;
	max-height: 16rem;
	overflow-y: auto;
	list-style: none;
	border: 1px solid var(--line);
	border-radius: 5px;
	background: var(--surface);
	box-shadow: 0 6px 18px rgb(0 0 0 / 35%);
}

.persons__item {
	padding: 0.3rem 0.5rem;
	border-radius: 3px;
	cursor: pointer;
	white-space: nowrap;
	color: var(--text);
}

.persons__item--on {
	background: var(--accent);
	color: var(--surface);
}

.persons__empty {
	padding: 0.3rem 0.5rem;
	color: var(--muted);
	font-size: 0.8rem;
}

.persons__search {
	padding: 0.25rem 0.15rem 0.35rem;
	border-bottom: 1px solid var(--line-soft);
	margin-bottom: 0.15rem;
	position: sticky;
	top: 0;
	background: var(--surface);
}

.persons__search input {
	width: 100%;
	box-sizing: border-box;
	padding: 0.3rem 0.5rem;
	font: inherit;
	font-size: 0.8rem;
}

.body {
	flex: 1;
	min-height: 0;
	display: grid;
	grid-template-columns: 1fr 22rem;
	gap: 0.6rem;
}

.side {
	overflow-y: auto;
	padding: 0.6rem 0.75rem;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--surface);
}

.side h2 {
	margin: 0 0 0.4rem;
	font-size: 0.8rem;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--muted);
}

.num {
	text-align: right;
}

.total {
	margin: 0.6rem 0 0;
	padding-top: 0.5rem;
	border-top: 1px solid var(--line);
	display: flex;
	justify-content: space-between;
}

.problems {
	margin: 0;
	padding-left: 1rem;
	color: var(--bad);
	font-size: 0.82rem;
}

.notice {
	margin: 0;
	padding: 0.4rem 0.6rem;
	border: 1px solid var(--line);
	border-radius: 5px;
	background: var(--surface);
}

.error {
	margin: 0;
	padding: 0.4rem 0.6rem;
	border: 1px solid var(--bad);
	border-radius: 5px;
	color: var(--bad);
}

.muted {
	margin: 0;
	color: var(--muted);
	font-size: 0.82rem;
}

.link {
	margin-left: 0.5rem;
	padding: 0;
	border: none;
	background: none;
	color: var(--accent);
	text-decoration: underline;
}
</style>
