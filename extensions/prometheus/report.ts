/**
 * The two terminal reports, /context-budget and /metrics.
 *
 * Both return lines rather than printing them, so they can be asserted on with
 * no TUI, rendered as a custom entry, or rasterised for the gallery. No Pi
 * import: `State` is a type-only import, erased at runtime.
 */
import { attributionMode, attributionTopN, byTokensDesc } from "./attribution.ts";
import type { Footprint, FootprintPart } from "./attribution.ts";
import type { State } from "./exposition.ts";
import { TARGETS_DIR } from "./targets.ts";

export interface BudgetReportInput {
	footprint: Footprint | null;
	/** What the session ingested at runtime. */
	runtime: readonly FootprintPart[];
	contextWindow: number | null;
}

const RULE = "-".repeat(76);
/** Rows per table in the terminal. The metric cap is a separate matter. */
const REPORT_ROWS = 10;

function padRight(s: string, n: number): string {
	let t = s;
	if (t.length > n) {
		// A path is recognised by its tail, a name by its head.
		t = /[/\\]/.test(t) ? `...${t.slice(t.length - n + 4)} ` : `${t.slice(0, n - 4)}... `;
	}
	return t + " ".repeat(Math.max(0, n - t.length));
}

function padLeft(s: string, n: number): string {
	const t = s.length > n ? s.slice(0, n) : s;
	return " ".repeat(n - t.length) + t;
}

function share(tokens: number, total: number): string {
	return total > 0 ? `${((100 * tokens) / total).toFixed(1)}%` : "-";
}

function entryRow(p: FootprintPart, total: number): string {
	return (
		padRight(p.kind, 15) +
		padRight(p.name, 23) +
		padRight(p.source, 18) +
		padLeft(String(p.tokens), 10) +
		padLeft(share(p.tokens, total), 10)
	);
}

/**
 * The /context-budget table at 76 columns. Returns lines, so it can be asserted
 * on with no TUI, rendered as a custom entry, or rasterised for the gallery.
 */
export function buildBudgetReport(input: BudgetReportInput): string[] {
	const fp = input.footprint;
	if (!fp || fp.parts.length === 0) {
		return ["context budget", RULE, "no system prompt seen yet in this session"];
	}

	const L: string[] = ["context budget", RULE];

	const counts = new Map<string, number>();
	const bySource = new Map<string, number>();
	for (const p of fp.parts) {
		counts.set(p.source, (counts.get(p.source) ?? 0) + 1);
		bySource.set(p.source, (bySource.get(p.source) ?? 0) + p.tokens);
	}
	L.push(
		padRight("by source", 46) + padLeft("entries", 10) + padLeft("tokens", 10) + padLeft("share", 10),
	);
	const sources = [...bySource].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
	for (const [source, tokens] of sources) {
		L.push(
			padRight(source, 46) +
				padLeft(String(counts.get(source) ?? 0), 10) +
				padLeft(String(tokens), 10) +
				padLeft(share(tokens, fp.total), 10),
		);
	}

	const largest = [...fp.parts].sort(byTokensDesc);
	L.push("", padRight("largest entries", 56) + padLeft("tokens", 10) + padLeft("share", 10));
	for (const p of largest.slice(0, REPORT_ROWS)) L.push(entryRow(p, fp.total));
	if (largest.length > REPORT_ROWS) L.push(`... and ${largest.length - REPORT_ROWS} more`);

	const runtime = [...input.runtime].sort(byTokensDesc);
	L.push("", padRight("loaded at runtime this session", 56) + padLeft("tokens", 10) + padLeft("share", 10));
	if (runtime.length === 0) L.push("nothing ingested yet");
	const runtimeTotal = runtime.reduce((n, p) => n + p.tokens, 0);
	for (const p of runtime.slice(0, REPORT_ROWS)) L.push(entryRow(p, runtimeTotal));
	if (runtime.length > REPORT_ROWS) L.push(`... and ${runtime.length - REPORT_ROWS} more`);

	L.push("", RULE);
	const window = input.contextWindow;
	L.push(
		window && window > 0
			? `static footprint ${fp.total} tokens, ${share(fp.total, window)} of the ${window} token window`
			: `static footprint ${fp.total} tokens`,
	);
	L.push("estimates only: chars/4, the same heuristic Pi uses to decide when to compact.");
	L.push("tool schemas are counted as schemas; the one-line tool list inside the system");
	L.push("prompt is counted under prompt_section, so the two are never added together.");
	return L;
}

/** The /metrics command: the session numbers plus where to scrape them. */
export function buildSessionReport(state: State, port: number): string[] {
	const L: string[] = ["pi-prometheus", RULE];
	L.push(padRight("endpoint", 24) + (port ? `http://127.0.0.1:${port}/metrics` : "not listening"));
	L.push(padRight("targets dir", 24) + TARGETS_DIR);
	L.push(padRight("session", 24) + (state.sessionId || "-"));
	L.push(padRight("model", 24) + (state.model || "-"));
	L.push("");
	L.push(padRight("input tokens", 24) + padLeft(String(state.tokens.input), 12));
	L.push(padRight("output tokens", 24) + padLeft(String(state.tokens.output), 12));
	L.push(padRight("cache read tokens", 24) + padLeft(String(state.tokens.cache_read), 12));
	L.push(padRight("cache write tokens", 24) + padLeft(String(state.tokens.cache_write), 12));
	L.push(padRight("cost usd", 24) + padLeft(state.costUsd.toFixed(4), 12));
	L.push(padRight("turns", 24) + padLeft(String(state.turns), 12));
	L.push(
		padRight("static footprint", 24) +
			padLeft(state.footprint ? String(state.footprint.total) : "-", 12),
	);
	L.push(padRight("attribution", 24) + `${attributionMode()}, top ${attributionTopN()}`);
	return L;
}
