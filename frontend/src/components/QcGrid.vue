<script setup lang="ts">
/**
 * The measuring grid.
 *
 * This is the component the whole application exists for, so the three rules that fix
 * the original complaint are worth stating plainly:
 *
 *   1. Nothing here awaits. A committed feetage resolves its size and rate from
 *      in-memory indexes held by the main process and repaints one row. There is no
 *      per-keystroke round trip, so typing speed is bounded by the operator, not the
 *      network.
 *   2. A value the operator typed is never rewritten. An out-of-range feetage is marked
 *      in red and reported at confirm time; it is never reset to zero, which is what the
 *      desk form does and what makes measurements appear to vanish.
 *   3. Focus is never moved except by a key the operator pressed. There are no deferred
 *      re-focus timers, so a keystroke can never land in a cell they did not choose.
 *
 * Only the visible slice of rows is rendered, so a GRN of 2,000 hides costs what 40 do.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import { caretAfterSanitize, sanitizeDecimal } from "../composables/decimalInput";
import { gradeOptions, matchGrade } from "../composables/grades";
import { nextPosition, type GridPosition } from "../composables/gridNavigation";
import { filterRows, type FilterKey, type RowFilters } from "../composables/rowFilter";
import { computeWindow, scrollToRow } from "../composables/virtualRows";
import type { DetailRow } from "../../../electron/preload";

const props = defineProps<{
	rows: DetailRow[];
	grades: string[];
	ratesVisible: boolean;
	readonly: boolean;
	problemRows: Set<number>;
}>();

const emit = defineEmits<{
	(event: "commit", payload: { id: number; field: "grade" | "feetage" | "status"; value: string }): void;
	(event: "reject", message: string): void;
	(event: "editorSave", payload: { id: number; grade: string; feetage: string }): void;
	(event: "appendRow"): void;
}>();

const ROW_HEIGHT = 34;

/** A header column: what to call it and whether it takes a search box. */
interface ColumnDef {
	key: FilterKey;
	label: string;
}

const viewport = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(600);
const active = ref<GridPosition>({ row: 0, column: "feetage" });
/** One search box per header column; filtered rows repaint as the operator types. */
const filters = reactive<RowFilters>({});
/** The raw string being typed. Committed on blur, Enter or navigation. */
const editing = ref<{ id: number; field: string; text: string } | null>(null);

/**
 * The open grade list.
 *
 * Positioned in viewport coordinates rather than inside the cell: the row body scrolls,
 * so a list drawn inside it would be clipped by the viewport on the last visible row -
 * which is exactly where an operator working down a stack tends to be.
 */
const picker = ref<{
	id: number;
	options: string[];
	highlight: number;
	/** True once the operator has typed or arrowed. Until then Enter still means "next row". */
	touched: boolean;
	left: number;
	top: number;
	width: number;
} | null>(null);

const pickerList = ref<HTMLElement | null>(null);

/**
 * The single-row editor opened by a row's Edit button.
 *
 * Unlike the inline grade cell - which fills a grade into every row below, as the desk
 * form does - this dialog changes only the row it was opened from. That is the desk
 * form's "Edit Grade" dialog: when a run needs one row corrected, the operator must be
 * able to fix that row without rewriting the work beneath it.
 */
const editor = ref<{
	id: number;
	idx: number;
	item_code: string | null;
	grade: string;
	feetage: string;
	error: string | null;
} | null>(null);

const editorGradeInput = ref<HTMLInputElement | null>(null);
const editorFeetageInput = ref<HTMLInputElement | null>(null);

const editorOptions = computed(() =>
	editor.value ? gradeOptions(props.grades, editor.value.grade) : []
);

function openEditor(row: DetailRow): void {
	editor.value = {
		id: row.id,
		idx: row.idx,
		item_code: row.item_code,
		grade: row.grade ?? "",
		feetage: row.feetage ? String(row.feetage) : "",
		error: null,
	};
	void nextTick(() => editorGradeInput.value?.focus());
}

function pickEditorGrade(value: string): void {
	if (editor.value) editor.value.grade = value;
}

function onEditorFeetageInput(event: Event): void {
	const input = event.target as HTMLInputElement;
	const raw = input.value;
	const clean = sanitizeDecimal(raw);

	if (clean !== raw) {
		const caret = caretAfterSanitize(raw, input.selectionStart ?? raw.length);
		input.value = clean;
		input.setSelectionRange(caret, caret);
	}

	if (editor.value) editor.value.feetage = clean;
}

/** Enter in the grade box takes the best match and hands the next keystroke to feetage. */
function onEditorGradeKeydown(event: KeyboardEvent): void {
	if (event.key !== "Enter") return;
	event.preventDefault();
	const open = editor.value;
	if (!open) return;

	const exact = matchGrade(props.grades, open.grade);
	if (!exact && editorOptions.value.length) open.grade = editorOptions.value[0]!;
	editorFeetageInput.value?.focus();
}

/** A grade must be one the master defines, or it is refused here rather than at submit. */
function editorSave(): void {
	const open = editor.value;
	if (!open) return;

	const typed = open.grade.trim();
	const matched = matchGrade(props.grades, typed);
	if (typed && !matched) {
		open.error = props.grades.length
			? `"${typed}" is not a grade. Pick one from the list.`
			: "No grades have synced from ERPNext yet, so a grade cannot be set.";
		return;
	}

	emit("editorSave", { id: open.id, grade: open.grade, feetage: open.feetage });
	editor.value = null;
}

/**
 * Set while the grid scrolls itself to reveal a cell it is moving to.
 *
 * Scroll events are delivered a beat late, so a keyboard move that scrolls would arrive
 * after the destination cell had already opened its list and close it again. A scroll the
 * operator performed still closes it.
 */
let selfScroll = false;

/** The columns a search box can narrow, matching the row columns, minus the Edit button. */
const headColumns = computed<ColumnDef[]>(() => {
	const defs: ColumnDef[] = [
		{ key: "idx", label: "#" },
		{ key: "item", label: "Item" },
		{ key: "skin", label: "Skin Type" },
		{ key: "grade", label: "Grade" },
		{ key: "feetage", label: "Feetage" },
		{ key: "size", label: "Size" },
	];
	if (props.ratesVisible) {
		defs.push({ key: "rate", label: "Rate" }, { key: "net", label: "Net" });
	}
	return defs;
});

const editableColumns = computed(() => (props.readonly ? [] : ["grade", "feetage"]));

/** The rows the filters let through; windowing renders only their visible slice. */
const filtered = computed(() => filterRows(props.rows, filters));

const window_ = computed(() =>
	computeWindow({
		scrollTop: scrollTop.value,
		viewportHeight: viewportHeight.value,
		rowHeight: ROW_HEIGHT,
		rowCount: filtered.value.length,
	})
);

const visible = computed(() =>
	filtered.value.slice(window_.value.start, window_.value.end).map((row, offset) => ({
		row,
		index: window_.value.start + offset,
	}))
);

const measured = computed(() => filtered.value.filter((row) => Number(row.feetage) > 0).length);

/** A filter reshapes the list under the caret, so park the grid back at the top. */
watch(filters, () => {
	scrollTop.value = 0;
	if (viewport.value) viewport.value.scrollTop = 0;
	closePicker();
	if (active.value.row >= filtered.value.length) {
		active.value = { row: Math.max(0, filtered.value.length - 1), column: active.value.column };
	}
});

function onScroll(event: Event): void {
	scrollTop.value = (event.target as HTMLElement).scrollTop;

	if (selfScroll) {
		selfScroll = false;
		return;
	}

	// The list is positioned against the cell as it was; once the cell moves, so has the
	// list, and a dropdown floating over the wrong row is worse than no dropdown.
	closePicker();
}

function cellValue(row: DetailRow, field: string): string {
	if (editing.value && editing.value.id === row.id && editing.value.field === field) {
		return editing.value.text;
	}
	if (field === "feetage") return row.feetage ? String(row.feetage) : "";
	if (field === "grade") return row.grade ?? "";
	return "";
}

/**
 * Filter a feetage box to digits and one decimal point.
 *
 * Done on `input` rather than `keydown` so a paste is cleaned too. The rejected character
 * never reaches the model, and the caret is put back where it was, so correcting the
 * middle of a number does not fling the cursor to the end.
 */
function onFeetageInput(event: Event, row: DetailRow): void {
	const input = event.target as HTMLInputElement;
	const raw = input.value;
	const clean = sanitizeDecimal(raw);

	if (clean !== raw) {
		const caret = caretAfterSanitize(raw, input.selectionStart ?? raw.length);
		input.value = clean;
		input.setSelectionRange(caret, caret);
	}

	editing.value = { id: row.id, field: "feetage", text: clean };
}

function beginEdit(row: DetailRow, field: string, initial?: string): void {
	editing.value = { id: row.id, field, text: initial ?? cellValue(row, field) };
}

/** Push the typed value down to the parent. Never rewrites what was typed. */
function commit(): void {
	const pending = editing.value;
	editing.value = null;
	closePicker();
	if (!pending) return;

	const row = props.rows.find((candidate) => candidate.id === pending.id);
	if (!row) return;

	if (pending.field === "grade") {
		const typed = pending.text.trim();
		const grade = matchGrade(props.grades, typed);

		// Rule 2 covers measurements: a feetage is the operator's reading and is kept
		// whatever it says. A grade is not a reading, it is a master value - one that is
		// not on the list prices nothing, groups into its own summary line and is refused
		// by ERPNext on submit. Refusing it here, out loud, beats discovering it at the
		// end of the shift. Clearing the cell stays allowed.
		if (typed && !grade) {
			emit(
				"reject",
				props.grades.length
					? `"${typed}" is not a grade. Pick one from the list.`
					: "No grades have synced from ERPNext yet, so a grade cannot be set."
			);
			return;
		}

		const value = grade ?? "";
		if (value === (row.grade ?? "")) return;

		emit("commit", { id: pending.id, field: "grade", value });
		return;
	}

	const current = row.feetage ? String(row.feetage) : "";
	if (pending.text === current) return;

	emit("commit", { id: pending.id, field: "feetage", value: pending.text });
}

async function focusCell(position: GridPosition): Promise<void> {
	active.value = position;

	const offset = scrollToRow(position.row, {
		scrollTop: scrollTop.value,
		viewportHeight: viewportHeight.value,
		rowHeight: ROW_HEIGHT,
	});
	if (offset !== null && viewport.value && viewport.value.scrollTop !== offset) {
		selfScroll = true;
		viewport.value.scrollTop = offset;
	}

	await nextTick();
	const selector = `[data-row="${position.row}"] [data-cell="${position.column}"] input`;
	const input = viewport.value?.querySelector<HTMLInputElement>(selector);
	input?.focus();
	input?.select();
}

function onKeydown(event: KeyboardEvent, rowIndex: number, column: string): void {
	const input = event.target as HTMLInputElement;

	const result = nextPosition(event.key, { row: rowIndex, column }, {
		columns: editableColumns.value,
		rowCount: props.rows.length,
		atStart: input.selectionStart === 0 && input.selectionEnd === 0,
		atEnd: input.selectionStart === input.value.length && input.selectionEnd === input.value.length,
	});

	if (result.kind === "none") return;

	event.preventDefault();
	commit();

	if (result.kind === "move") void focusCell(result.to);
}

function onFocus(rowIndex: number, column: string, row: DetailRow): void {
	active.value = { row: rowIndex, column };
	beginEdit(row, column);
}

// --- grade: a picker over the Grade master, not a free text box ---

function openPicker(row: DetailRow, input: HTMLInputElement, text: string, touched = false): void {
	const options = gradeOptions(props.grades, text);
	const exact = matchGrade(props.grades, text);
	const box = input.getBoundingClientRect();

	picker.value = {
		id: row.id,
		options,
		highlight: exact ? Math.max(0, options.indexOf(exact)) : 0,
		touched,
		left: box.left,
		top: box.bottom + 2,
		width: Math.max(box.width, 140),
	};
}

function closePicker(): void {
	picker.value = null;
}

function pickerOpenFor(row: DetailRow): boolean {
	return !!picker.value && picker.value.id === row.id;
}

/** Move the highlight and keep it in view; the list scrolls once the grades outgrow it. */
async function moveHighlight(step: number): Promise<void> {
	const open = picker.value;
	if (!open || !open.options.length) return;

	open.highlight = (open.highlight + step + open.options.length) % open.options.length;
	open.touched = true;

	await nextTick();
	const item = pickerList.value?.children[open.highlight] as HTMLElement | undefined;
	item?.scrollIntoView({ block: "nearest" });
}

/** Put a grade in the cell without committing it, so Enter and Tab can decide what next. */
function choose(row: DetailRow, value: string): void {
	editing.value = { id: row.id, field: "grade", text: value };
	closePicker();
}

function onGradeFocus(event: FocusEvent, rowIndex: number, row: DetailRow): void {
	onFocus(rowIndex, "grade", row);
	openPicker(row, event.target as HTMLInputElement, cellValue(row, "grade"));
}

function onGradeInput(event: Event, row: DetailRow): void {
	const input = event.target as HTMLInputElement;
	editing.value = { id: row.id, field: "grade", text: input.value };
	openPicker(row, input, input.value, true);
}

function onGradePick(value: string): void {
	const row = props.rows.find((candidate) => candidate.id === picker.value?.id);
	if (!row) return;
	choose(row, value);
	commit();
}

/**
 * Keys the open list claims, before the grid sees them.
 *
 * Up and Down walk the suggestions while it is open and rows once it is closed, which is
 * how a Link field behaves inside a Frappe grid; Escape closes it and hands navigation
 * straight back. Enter takes the highlighted grade and stays put - a second Enter then
 * moves down - so picking a grade and leaving the row are two deliberate keystrokes
 * rather than one that does both.
 */
function onGradeKeydown(event: KeyboardEvent, rowIndex: number, row: DetailRow): void {
	const open = picker.value && picker.value.id === row.id ? picker.value : null;

	if (open) {
		if (event.key === "Escape") {
			event.preventDefault();
			closePicker();
			return;
		}

		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			void moveHighlight(event.key === "ArrowDown" ? 1 : -1);
			return;
		}

		// `touched` is what keeps the list from answering a question nobody asked. It opens
		// on focus, so without this an operator pressing Enter to move down a column would
		// take whatever grade happened to be highlighted - and, since a grade fills down,
		// hand it to every row beneath as well.
		if (open.touched && (event.key === "Enter" || event.key === "Tab")) {
			const choice = open.options[open.highlight];
			if (choice) choose(row, choice);
			else closePicker();

			// Enter settles the cell and stays; a second Enter moves down. Tab falls through
			// so the grid carries it on to the feetage box, which is where the operator is
			// going next anyway.
			if (event.key === "Enter") {
				event.preventDefault();
				commit();
				return;
			}
		}
	}

	onKeydown(event, rowIndex, "grade");
}

// The window size depends on how tall the viewport actually is, so measure it rather
// than assuming: a wrong height either renders too few rows (blank gaps on scroll) or
// far too many (the cost this component exists to avoid).
let observer: ResizeObserver | null = null;

onMounted(() => {
	if (!viewport.value) return;
	viewportHeight.value = viewport.value.clientHeight;
	observer = new ResizeObserver(([entry]) => {
		if (entry) viewportHeight.value = entry.contentRect.height;
	});
	observer.observe(viewport.value);
});

onBeforeUnmount(() => observer?.disconnect());

watch(
	() => props.rows.length,
	() => {
		if (active.value.row >= props.rows.length) {
			active.value = { row: Math.max(0, props.rows.length - 1), column: active.value.column };
		}
	}
);

defineExpose({ focusCell });
</script>

<template>
	<div class="grid" :class="{ 'grid--no-rates': !ratesVisible }">
		<div class="grid__head">
			<div v-for="column in headColumns" :key="column.key" class="hd" :class="`hd--${column.key}`">
				<span class="hd__label">{{ column.label }}</span>
				<input
					v-model="filters[column.key]"
					type="search"
					class="hd__filter"
					:aria-label="`Filter ${column.label}`"
					:placeholder="column.label"
					autocomplete="off"
					spellcheck="false"
				/>
			</div>
			<div class="hd hd--edit">
				<span class="hd__label">Edit</span>
			</div>
		</div>

		<div ref="viewport" class="grid__body" @scroll="onScroll">
			<div :style="{ height: `${window_.paddingTop}px` }" />

			<div
				v-for="entry in visible"
				:key="entry.row.id"
				class="row"
				:class="{ 'row--problem': problemRows.has(entry.row.idx), 'row--done': Number(entry.row.feetage) > 0 }"
				:data-row="entry.index"
				:style="{ height: `${ROW_HEIGHT}px` }"
			>
				<span class="col col--idx">{{ entry.row.idx }}</span>
				<span class="col col--item" :title="entry.row.item_code ?? ''">{{ entry.row.item_code }}</span>
				<span class="col col--skin">{{ entry.row.skin_type }}</span>

				<span class="col col--grade" data-cell="grade">
					<input
						:value="cellValue(entry.row, 'grade')"
						:disabled="readonly"
						role="combobox"
						aria-autocomplete="list"
						:aria-expanded="pickerOpenFor(entry.row)"
						spellcheck="false"
						autocomplete="off"
						@focus="onGradeFocus($event, entry.index, entry.row)"
						@input="onGradeInput($event, entry.row)"
						@blur="commit"
						@keydown="onGradeKeydown($event, entry.index, entry.row)"
					/>
				</span>

				<span class="col col--feet" data-cell="feetage">
					<input
						:value="cellValue(entry.row, 'feetage')"
						:disabled="readonly"
						type="text"
						inputmode="decimal"
						spellcheck="false"
						autocomplete="off"
						:class="{ 'input--bad': problemRows.has(entry.row.idx) }"
						@focus="onFocus(entry.index, 'feetage', entry.row)"
						@input="onFeetageInput($event, entry.row)"
						@blur="commit"
						@keydown="onKeydown($event, entry.index, 'feetage')"
					/>
				</span>

				<span class="col col--size">{{ entry.row.size }}</span>
				<span v-if="ratesVisible" class="col col--rate">{{ entry.row.rate || "" }}</span>
				<span v-if="ratesVisible" class="col col--net">{{ entry.row.net_amount || "" }}</span>
				<span class="col col--edit">
					<button
						type="button"
						class="row__edit"
						:disabled="readonly"
						:title="`Edit row ${entry.row.idx}`"
						@click="openEditor(entry.row)"
					>
						Edit
					</button>
				</span>
			</div>

			<div :style="{ height: `${window_.paddingBottom}px` }" />
		</div>

		<!--
			mousedown, not click, and prevented: the grade input must not lose focus to the
			list, or the blur would commit and close it before the click ever landed.
		-->
		<ul
			v-if="picker"
			ref="pickerList"
			class="picker"
			:style="{ left: `${picker.left}px`, top: `${picker.top}px`, width: `${picker.width}px` }"
		>
			<li
				v-for="(option, index) in picker.options"
				:key="option"
				class="picker__item"
				:class="{ 'picker__item--on': index === picker.highlight }"
				@mousedown.prevent="onGradePick(option)"
			>
				{{ option }}
			</li>
			<li v-if="!picker.options.length" class="picker__item picker__item--empty">No matching grade</li>
		</ul>

		<!--
			The single-row editor: Grade and Feetage for the one row whose Edit button was
			pressed. Saving it never fills down - a corrected row must not rewrite the rows
			beneath it. Escape or a click on the backdrop dismisses it.
		-->
		<div v-if="editor" class="editor" @click.self="editor = null" @keydown.esc="editor = null">
			<div class="editor__box" role="dialog" aria-modal="true" :aria-label="`Edit row ${editor.idx}`">
				<header class="editor__head">
					<div>
						<strong>Row {{ editor.idx }}</strong>
						<span class="editor__sub">{{ editor.item_code }}</span>
					</div>
					<button type="button" class="editor__close" aria-label="Close" @click="editor = null">×</button>
				</header>

				<label class="editor__field">
					<span class="editor__label">Grade</span>
					<input
						ref="editorGradeInput"
						v-model="editor.grade"
						type="text"
						role="combobox"
						aria-autocomplete="list"
						spellcheck="false"
						autocomplete="off"
						@keydown="onEditorGradeKeydown"
					/>
				</label>

				<ul v-if="editorOptions.length" class="editor__options">
					<li
						v-for="option in editorOptions"
						:key="option"
						class="editor__option"
						:class="{ 'editor__option--on': option === editor.grade }"
						@click="pickEditorGrade(option)"
					>
						{{ option }}
					</li>
				</ul>

				<label class="editor__field">
					<span class="editor__label">Feetage</span>
					<input
						ref="editorFeetageInput"
						:value="editor.feetage"
						type="text"
						inputmode="decimal"
						spellcheck="false"
						autocomplete="off"
						@input="onEditorFeetageInput"
					/>
				</label>

				<p v-if="editor.error" class="editor__error">{{ editor.error }}</p>

				<footer class="editor__actions">
					<button type="button" class="btn" @click="editor = null">Cancel</button>
					<button type="button" class="btn btn--primary" @click="editorSave">Save</button>
				</footer>
			</div>
		</div>

		<footer class="grid__foot">
			<span class="foot__stats">
				<span>{{ measured }} of {{ filtered.length }} measured</span>
				<button
					type="button"
					class="foot__add"
					:disabled="readonly"
					:title="`Copy the last row (row ${filtered.length}) and add it as a new row`"
					@click="emit('appendRow')"
				>
					Add row
				</button>
			</span>
			<span class="hint">Enter or Down moves to the next hide. A grade fills every row below it.</span>
		</footer>
	</div>
</template>

<style scoped>
.grid {
	display: flex;
	flex-direction: column;
	min-height: 0;
	flex: 1;
	border: 1px solid var(--line);
	border-radius: 6px;
	overflow: hidden;
	background: var(--surface);
}

.grid__head,
.row {
	display: grid;
	/* idx, item, skin, grade, feetage, size, rate, net, edit */
	grid-template-columns: 3.5rem 9rem 6rem 6rem 6rem 8rem 6rem 6rem 4rem;
	align-items: center;
	gap: 0.25rem;
	padding: 0 0.5rem;
}

.grid__head {
	padding: 0.35rem 0.5rem 0.3rem;
	font-size: 0.75rem;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--muted);
	background: var(--surface-2);
	border-bottom: 1px solid var(--line);
	align-items: stretch;
}

/* Each header cell stacks its label over its filter box, in the same column track as
   the rows beneath, so the filters line up with the cells they narrow. */
.hd {
	display: flex;
	flex-direction: column;
	gap: 0.12rem;
	min-width: 0;
}

.hd--edit {
	align-items: flex-end;
	justify-content: center;
}

.hd__label {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.hd__filter {
	width: 100%;
	box-sizing: border-box;
	height: 20px;
	padding: 0 0.3rem;
	border: 1px solid var(--line);
	border-radius: 3px;
	background: var(--surface);
	color: var(--text);
	font: inherit;
	font-size: 0.72rem;
	text-transform: none;
	letter-spacing: 0;
}

.hd__filter:focus {
	outline: none;
	border-color: var(--accent);
}

/* Rate and Net are withheld from operators without permlevel-1 read on Tounch Rate. */
.grid--no-rates .grid__head,
.grid--no-rates .row {
	grid-template-columns: 3.5rem 9rem 6rem 6rem 6rem 8rem 4rem;
}

.grid__body {
	flex: 1;
	overflow-y: auto;
	min-height: 0;
}

.row {
	border-bottom: 1px solid var(--line-soft);
	font-variant-numeric: tabular-nums;
}

.row--done {
	background: var(--done);
}

.row--problem {
	background: var(--bad-bg);
}

.col {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.col--idx {
	color: var(--muted);
	font-size: 0.8rem;
}

.col--feet input,
.col--grade input {
	width: 100%;
	height: 26px;
	padding: 0 0.4rem;
	border: 1px solid transparent;
	border-radius: 4px;
	background: transparent;
	color: inherit;
	font: inherit;
	font-variant-numeric: tabular-nums;
}

.col--feet input:focus,
.col--grade input:focus {
	outline: none;
	border-color: var(--accent);
	background: var(--surface);
}

/* The grade cell reads as a picker rather than a text box, and says so before it is
   clicked: an operator who types a grade nobody has defined gets it refused. */
.col--grade {
	position: relative;
}

.col--grade::after {
	content: "\25be";
	position: absolute;
	right: 0.35rem;
	top: 50%;
	transform: translateY(-50%);
	color: var(--muted);
	font-size: 0.7rem;
	pointer-events: none;
}

.col--grade input {
	padding-right: 1rem;
}

/* Viewport coordinates, so the row body cannot clip the list on the last visible row. */
.picker {
	position: fixed;
	z-index: 20;
	margin: 0;
	padding: 0.15rem;
	max-height: 12rem;
	overflow-y: auto;
	list-style: none;
	border: 1px solid var(--line);
	border-radius: 5px;
	background: var(--surface);
	box-shadow: 0 6px 18px rgb(0 0 0 / 35%);
}

.picker__item {
	padding: 0.25rem 0.5rem;
	border-radius: 3px;
	cursor: pointer;
	white-space: nowrap;
}

.picker__item--on {
	background: var(--accent);
	color: var(--surface);
}

.picker__item--empty {
	color: var(--muted);
	cursor: default;
}

.col--edit {
	display: flex;
	justify-content: flex-end;
}

.row__edit {
	padding: 0.15rem 0.5rem;
	font: inherit;
	font-size: 0.75rem;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--surface-2);
	color: inherit;
	cursor: pointer;
}

.row__edit:hover:not(:disabled) {
	border-color: var(--accent);
	color: var(--accent);
}

.row__edit:disabled {
	opacity: 0.5;
	cursor: default;
}

/* The single-row editor: a dialog over the grid, so it never fights a scrolled viewport. */
.editor {
	position: fixed;
	inset: 0;
	z-index: 30;
	display: flex;
	align-items: center;
	justify-content: center;
	background: rgb(0 0 0 / 45%);
}

.editor__box {
	width: 20rem;
	max-width: calc(100vw - 2rem);
	box-sizing: border-box;
	padding: 0.9rem;
	border: 1px solid var(--line);
	border-radius: 8px;
	background: var(--surface);
	box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
}

.editor__head {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	margin-bottom: 0.8rem;
}

.editor__sub {
	margin-left: 0.5rem;
	color: var(--muted);
	font-size: 0.8rem;
}

.editor__close {
	border: 0;
	background: none;
	padding: 0;
	font-size: 1rem;
	line-height: 1;
	color: var(--muted);
	cursor: pointer;
}

.editor__field {
	display: flex;
	flex-direction: column;
	gap: 0.25rem;
	margin-top: 0.6rem;
}

.editor__label {
	font-size: 0.7rem;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--muted);
}

.editor__field input {
	width: 100%;
	box-sizing: border-box;
	padding: 0.3rem 0.5rem;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--surface);
	color: inherit;
	font: inherit;
}

.editor__field input:focus {
	outline: none;
	border-color: var(--accent);
}

.editor__options {
	list-style: none;
	margin: 0.3rem 0 0;
	padding: 0.15rem;
	max-height: 10rem;
	overflow-y: auto;
	border: 1px solid var(--line);
	border-radius: 5px;
	background: var(--surface);
}

.editor__option {
	padding: 0.25rem 0.5rem;
	border-radius: 3px;
	cursor: pointer;
}

.editor__option--on {
	background: var(--accent);
	color: var(--surface);
}

.editor__error {
	margin: 0.6rem 0 0;
	color: var(--bad);
	font-size: 0.8rem;
}

.editor__actions {
	display: flex;
	justify-content: flex-end;
	gap: 0.5rem;
	margin-top: 0.9rem;
}

.btn {
	padding: 0.35rem 0.75rem;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--surface-2);
	color: inherit;
	font: inherit;
	cursor: pointer;
}

.btn--primary {
	background: var(--accent);
	border-color: var(--accent);
	color: var(--surface);
}

/* Marked, never rewritten. */
.input--bad {
	border-color: var(--bad) !important;
	color: var(--bad);
}

.grid__foot {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 1rem;
	padding: 0.4rem 0.75rem;
	border-top: 1px solid var(--line);
	background: var(--surface-2);
	font-size: 0.8rem;
	color: var(--muted);
}

.foot__stats {
	display: flex;
	align-items: center;
	gap: 0.6rem;
}

.foot__add {
	padding: 0.2rem 0.6rem;
	font: inherit;
	font-size: 0.75rem;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: var(--surface);
	color: inherit;
	cursor: pointer;
}

.foot__add:hover:not(:disabled) {
	border-color: var(--accent);
	color: var(--accent);
}

.foot__add:disabled {
	opacity: 0.5;
	cursor: default;
}

.hint {
	opacity: 0.8;
}
</style>
