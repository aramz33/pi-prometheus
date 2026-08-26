/**
 * pi-prometheus — Prometheus exporter for the Pi coding agent.
 *
 * Each Pi session serves /metrics on an ephemeral localhost port and
 * announces itself through Prometheus file-based service discovery:
 * a target file is written to ~/.pi/metrics/targets/<pid>.json on start
 * and removed on shutdown. Point your scraper at that directory once
 * (file_sd_configs) and every session — 1 or 10 in parallel — is scraped
 * automatically. See the repo README for scrape configs.
 *
 * On top of the session counters it attributes the context window to the
 * thing that filled it: which tool, which skill, which context file, and
 * above all which package they came from. /context-budget prints that table
 * in the terminal, with no Prometheus anywhere.
 *
 * Override the target directory with PI_PROMETHEUS_DIR.
 * PI_PROMETHEUS_ATTRIBUTION         off | rollup | full   (default full)
 * PI_PROMETHEUS_ATTRIBUTION_TOP_N   named series kept      (default 30)
 * PI_PROMETHEUS_STATUS              off | port | full      (default port)
 */
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS_DIR =
	process.env.PI_PROMETHEUS_DIR ?? path.join(os.homedir(), ".pi", "metrics", "targets");

// Turn durations on local models routinely reach minutes; buckets are seconds.
const TURN_BUCKETS = [5, 15, 30, 60, 120, 300, 600];

// ===========================================================================
// Attribution, as pure functions
//
// Everything under this banner takes plain data and returns plain data, so the
// test suite drives it with no running Pi. The wiring at the bottom of the file
// is the only part that touches the ExtensionAPI.
// ===========================================================================

/** Closed set. An unbounded `kind` would be a cardinality bomb by itself. */
export type FootprintKind = "tool" | "skill" | "context_file" | "prompt_section" | "other";

export type AttributionMode = "off" | "rollup" | "full";

export interface FootprintPart {
	kind: FootprintKind;
	name: string;
	/** SourceInfo.source: builtin, npm:<pkg>, git:<host/repo>, local. */
	source: string;
	tokens: number;
}

export interface Footprint {
	parts: FootprintPart[];
	/** Sum of every part, before any cardinality cap is applied. */
	total: number;
	/** Cheap identity of the inputs, so a repeat turn skips the computation. */
	signature: string;
}

/** The fields of Pi's `Skill` that the footprint needs. */
export interface SkillLike {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo?: { source?: string };
	disableModelInvocation?: boolean;
}

/** The fields of Pi's `ToolInfo` that the footprint needs. */
export interface ToolLike {
	name: string;
	description?: string;
	parameters?: unknown;
	sourceInfo?: { source?: string };
}

export interface FootprintInput {
	/** The real assembled string from before_agent_start, never a re-derivation. */
	systemPrompt: string;
	skills?: readonly SkillLike[];
	contextFiles?: readonly { path: string; content: string }[];
	/** Everything pi.getAllTools() returns: configured, not necessarily active. */
	tools?: readonly ToolLike[];
	/** pi.getActiveTools(), or systemPromptOptions.selectedTools. */
	activeTools?: readonly string[];
}

const UNKNOWN_SOURCE = "unknown";
/** Context files are project files; Pi carries no SourceInfo for them. */
const CONTEXT_FILE_SOURCE = "local";
/** The scaffolding around the parts is Pi's own text. */
const PROMPT_SECTION_SOURCE = "builtin";

/**
 * Pi's own heuristic, chars/4, so our numbers and Pi's context gauge agree by
 * construction (dist/core/compaction/compaction.js:188). It is an estimate and
 * nothing in this file claims otherwise.
 */
export function estimateTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

// dist/core/compaction/compaction.js:168
const ESTIMATED_IMAGE_CHARS = 4800;

/** The same five replacements as Pi's escapeXml, dist/core/skills.js:297. */
function xmlEscape(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

// The <available_skills> preamble, verbatim from formatSkillsForPrompt
// (dist/core/skills.js:257). Pi joins its lines with "\n", so every line costs
// its own length plus one separator.
const SKILLS_PROMPT_HEADER = [
	"\n\nThe following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load a skill's file when the task matches its description.",
	"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
	"",
	"<available_skills>",
];
const SKILLS_PROMPT_FOOTER = "</available_skills>";

function skillsBlockOverheadChars(): number {
	return SKILLS_PROMPT_HEADER.reduce((n, l) => n + l.length + 1, 0) + SKILLS_PROMPT_FOOTER.length;
}

/**
 * What one skill costs in the system prompt: name, description and location.
 * Never the SKILL.md body. Pi is progressive disclosure, so the body is read on
 * demand and turns up in the runtime counter instead.
 */
function skillEntryChars(skill: SkillLike): number {
	return [
		"  <skill>",
		`    <name>${xmlEscape(skill.name)}</name>`,
		`    <description>${xmlEscape(skill.description)}</description>`,
		`    <location>${xmlEscape(skill.filePath)}</location>`,
		"  </skill>",
	].reduce((n, l) => n + l.length + 1, 0);
}

// The <project_context> wrapper, verbatim from buildSystemPrompt
// (dist/core/system-prompt.js).
function contextBlockOverheadChars(): number {
	return (
		"\n\n<project_context>\n\n".length +
		"Project-specific instructions and guidelines:\n\n".length +
		"</project_context>\n".length
	);
}

function contextFileChars(file: { path: string; content: string }): number {
	return `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`
		.length;
}

/** A tool schema as it goes on the wire, beside the system prompt, not inside it. */
function toolSchemaChars(tool: ToolLike): number {
	return JSON.stringify({
		name: tool.name,
		description: tool.description ?? "",
		parameters: tool.parameters ?? {},
	}).length;
}

function sourceOf(info: { source?: string } | undefined): string {
	return info?.source || UNKNOWN_SOURCE;
}

/** Recomputing the footprint every turn would cost more than the metric is worth. */
export function footprintSignature(input: FootprintInput): string {
	const tools = [...(input.activeTools ?? [])].sort().join(",");
	const files = (input.contextFiles ?? []).map((f) => f.path).join(",");
	return `${input.systemPrompt.length}|${tools}|${(input.skills ?? []).length}|${files}`;
}

/**
 * The static cost of a turn, split by what caused it.
 *
 * Measured in characters first and converted per part, so the parts sum to the
 * total exactly. The two halves stay deliberately apart: prompt sections are
 * measured against the real systemPrompt string, tool schemas against the tool
 * definitions. A tool therefore appears twice, once as a one-line entry inside
 * the prompt (counted under prompt_section) and once as its full schema
 * (counted under tool). They are never folded into a single number.
 */
export function computeFootprint(input: FootprintInput): Footprint {
	const parts: FootprintPart[] = [];
	const active = new Set(input.activeTools ?? []);

	// getAllTools() returns configured tools. Attributing without intersecting
	// bills the user for tools that were never sent.
	for (const tool of input.tools ?? []) {
		if (!active.has(tool.name)) continue;
		parts.push({
			kind: "tool",
			name: tool.name,
			source: sourceOf(tool.sourceInfo),
			tokens: estimateTokens(toolSchemaChars(tool)),
		});
	}

	// Pi drops model-invocation-disabled skills from the prompt, and drops the
	// whole block when the read tool is absent.
	const skills = (input.skills ?? []).filter((s) => !s.disableModelInvocation);
	let skillsChars = 0;
	if (skills.length > 0 && active.has("read")) {
		skillsChars = skillsBlockOverheadChars();
		for (const skill of skills) {
			const chars = skillEntryChars(skill);
			skillsChars += chars;
			parts.push({
				kind: "skill",
				name: skill.name,
				source: sourceOf(skill.sourceInfo),
				tokens: estimateTokens(chars),
			});
		}
		parts.push({
			kind: "prompt_section",
			name: "available_skills",
			source: PROMPT_SECTION_SOURCE,
			tokens: estimateTokens(skillsBlockOverheadChars()),
		});
	}

	const files = input.contextFiles ?? [];
	let contextChars = 0;
	if (files.length > 0) {
		contextChars = contextBlockOverheadChars();
		for (const file of files) {
			const chars = contextFileChars(file);
			contextChars += chars;
			parts.push({
				kind: "context_file",
				name: file.path,
				source: CONTEXT_FILE_SOURCE,
				tokens: estimateTokens(chars),
			});
		}
		parts.push({
			kind: "prompt_section",
			name: "project_context",
			source: PROMPT_SECTION_SOURCE,
			tokens: estimateTokens(contextBlockOverheadChars()),
		});
	}

	// Whatever the two blocks did not account for is Pi's own instructions,
	// the one-line tool list and the guidelines included.
	const baseChars = Math.max(0, input.systemPrompt.length - skillsChars - contextChars);
	parts.push({
		kind: "prompt_section",
		name: "base_instructions",
		source: PROMPT_SECTION_SOURCE,
		tokens: estimateTokens(baseChars),
	});

	const merged = mergeParts(parts);
	return {
		parts: merged,
		total: merged.reduce((n, p) => n + p.tokens, 0),
		signature: footprintSignature(input),
	};
}

/** Unit separator: a label value can hold a space or a slash, never this. */
const KEY_SEP = "\u001f";

function partKey(p: FootprintPart): string {
	return `${p.kind}${KEY_SEP}${p.name}${KEY_SEP}${p.source}`;
}

/** Two parts sharing a label set would be a duplicate series on scrape. */
export function mergeParts(parts: readonly FootprintPart[]): FootprintPart[] {
	const byKey = new Map<string, FootprintPart>();
	for (const p of parts) {
		const seen = byKey.get(partKey(p));
		if (seen) seen.tokens += p.tokens;
		else byKey.set(partKey(p), { ...p });
	}
	return [...byKey.values()];
}

function byTokensDesc(a: FootprintPart, b: FootprintPart): number {
	return b.tokens - a.tokens || a.name.localeCompare(b.name);
}

/**
 * Keep the top N named series and fold the tail into one `other` series. The
 * tail is folded, not dropped, so a sum over the family still lands on the
 * truth. A cap of zero or less means no cap.
 */
export function capParts(parts: readonly FootprintPart[], topN: number): FootprintPart[] {
	const sorted = [...parts].sort(byTokensDesc);
	if (!Number.isFinite(topN) || topN <= 0 || sorted.length <= topN) return sorted;
	const kept = sorted.slice(0, topN);
	const folded = sorted.slice(topN).reduce((n, p) => n + p.tokens, 0);
	kept.push({ kind: "other", name: "other", source: "other", tokens: folded });
	return kept;
}

/**
 * Collapse the only unbounded label. `kind` stays: it is a closed set of five,
 * so keeping it tells the user more at no cardinality cost.
 */
export function rollupParts(parts: readonly FootprintPart[]): FootprintPart[] {
	return mergeParts(parts.map((p) => ({ ...p, name: "_all" }))).sort(byTokensDesc);
}

/** Read at render time, not at module load: one process can see both settings. */
export function attributionMode(): AttributionMode {
	const raw = process.env.PI_PROMETHEUS_ATTRIBUTION;
	return raw === "off" || raw === "rollup" || raw === "full" ? raw : "full";
}

export function attributionTopN(): number {
	const raw = process.env.PI_PROMETHEUS_ATTRIBUTION_TOP_N;
	const n = raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(n) ? n : 30;
}

/** Mode then cap, in that order: the shape that reaches the exposition. */
export function seriesFor(
	parts: readonly FootprintPart[],
	mode: AttributionMode,
	topN: number,
): FootprintPart[] {
	if (mode === "off") return [];
	if (mode === "rollup") return rollupParts(parts);
	return capParts(parts, topN);
}

// ===========================================================================
// The report, also pure
// ===========================================================================

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
	for (const p of fp.parts) counts.set(p.source, (counts.get(p.source) ?? 0) + 1);
	L.push(
		padRight("by source", 46) + padLeft("entries", 10) + padLeft("tokens", 10) + padLeft("share", 10),
	);
	for (const p of rollupParts(fp.parts.map((q) => ({ ...q, kind: "other" as const })))) {
		L.push(
			padRight(p.source, 46) +
				padLeft(String(counts.get(p.source) ?? 0), 10) +
				padLeft(String(p.tokens), 10) +
				padLeft(share(p.tokens, fp.total), 10),
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

// ===========================================================================
// Session state and exposition
// ===========================================================================

export interface State {
	tokens: { input: number; output: number; cache_read: number; cache_write: number };
	costUsd: number;
	turns: number;
	toolCalls: Map<string, number>;
	toolErrors: Map<string, number>;
	compactions: Map<string, number>;
	compactionFailures: Map<string, number>;
	turnBucketCounts: number[]; // one per TURN_BUCKETS entry, cumulative rendering at scrape time
	turnDurationSum: number;
	turnDurationCount: number;
	contextTokens: number | null;
	contextWindow: number | null;
	model: string;
	sessionId: string;
	cwd: string;
	startTime: number;
	/** Static footprint of the last system prompt seen, cached on its signature. */
	footprint: Footprint | null;
	/** What the session ingested at runtime, keyed by kind/name/source. */
	sourceTokens: Map<string, FootprintPart>;
	/** Sub-agent usage reported on tool results, keyed tool + token type. */
	nestedTokens: Map<string, number>;
	nestedCost: Map<string, number>;
	/** Last seen tool sources and skills, for runtime attribution. */
	toolSources: Map<string, string>;
	skills: SkillLike[];
}

// Pi caches the extension module per {cwd, generation} and only clears that cache
// on reload, so on /new, resume and fork the factory is re-invoked while anything
// held at module scope survives. Session state is therefore built per session.
function newState(): State {
	return {
		tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
		costUsd: 0,
		turns: 0,
		toolCalls: new Map(),
		toolErrors: new Map(),
		compactions: new Map(),
		compactionFailures: new Map(),
		turnBucketCounts: TURN_BUCKETS.map(() => 0),
		turnDurationSum: 0,
		turnDurationCount: 0,
		contextTokens: null,
		contextWindow: null,
		model: "",
		sessionId: "",
		cwd: "",
		startTime: Date.now() / 1000,
		footprint: null,
		sourceTokens: new Map(),
		nestedTokens: new Map(),
		nestedCost: new Map(),
		toolSources: new Map(),
		skills: [],
	};
}

function esc(v: string): string {
	return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function readPackageVersion(): string {
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8"));
		return typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Pi's version is not on the extension context, and importing the package would
 * turn a peer dependency into a runtime one. Walk up from the running script
 * instead, which lands on Pi's own package.json when Pi is what is running. The
 * name check is what keeps the label honest when something else is running us.
 */
function detectPiVersion(): string {
	let dir: string;
	try {
		dir = path.dirname(fs.realpathSync(process.argv[1] ?? ""));
	} catch {
		return "unknown";
	}
	for (let i = 0; i < 6; i++) {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
			if (pkg.name === PI_PACKAGE && typeof pkg.version === "string") return pkg.version;
		} catch {
			/* not at this level, keep walking */
		}
		const up = path.dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return "unknown";
}

const PACKAGE_VERSION = readPackageVersion();
const PI_VERSION = detectPiVersion();

function renderMetrics(state: State): string {
	const L: string[] = [];
	const line = (name: string, value: number, labels?: Record<string, string>) => {
		const l = labels
			? "{" + Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(",") + "}"
			: "";
		L.push(`${name}${l} ${value}`);
	};

	L.push("# HELP pi_session_info Static info about this Pi session (value is always 1).");
	L.push("# TYPE pi_session_info gauge");
	line("pi_session_info", 1, { model: state.model, cwd: state.cwd, session_id: state.sessionId });

	L.push("# HELP pi_prometheus_build_info Exporter version and the Pi it runs in (value is always 1).");
	L.push("# TYPE pi_prometheus_build_info gauge");
	line("pi_prometheus_build_info", 1, { version: PACKAGE_VERSION, pi_version: PI_VERSION });

	L.push("# HELP pi_session_start_time_seconds Unix time the exporter started.");
	L.push("# TYPE pi_session_start_time_seconds gauge");
	line("pi_session_start_time_seconds", state.startTime);

	L.push("# HELP pi_tokens_total Tokens consumed by the session, by type.");
	L.push("# TYPE pi_tokens_total counter");
	for (const [type, v] of Object.entries(state.tokens)) line("pi_tokens_total", v, { type });

	L.push("# HELP pi_cost_usd_total Cumulative cost in USD as reported by the provider cost model.");
	L.push("# TYPE pi_cost_usd_total counter");
	line("pi_cost_usd_total", state.costUsd);

	L.push("# HELP pi_turns_total Agent turns completed.");
	L.push("# TYPE pi_turns_total counter");
	line("pi_turns_total", state.turns);

	L.push("# HELP pi_tool_calls_total Tool executions, by tool.");
	L.push("# TYPE pi_tool_calls_total counter");
	for (const [tool, v] of state.toolCalls) line("pi_tool_calls_total", v, { tool });

	L.push("# HELP pi_tool_errors_total Tool executions that returned an error, by tool.");
	L.push("# TYPE pi_tool_errors_total counter");
	for (const [tool, v] of state.toolErrors) line("pi_tool_errors_total", v, { tool });

	L.push("# HELP pi_compactions_total Context compactions, by trigger reason.");
	L.push("# TYPE pi_compactions_total counter");
	for (const [reason, v] of state.compactions) line("pi_compactions_total", v, { reason });

	L.push("# HELP pi_compaction_failures_total Compactions that failed or were aborted, by trigger reason.");
	L.push("# TYPE pi_compaction_failures_total counter");
	for (const [reason, v] of state.compactionFailures) {
		line("pi_compaction_failures_total", v, { reason });
	}

	if (state.footprint) {
		L.push("# HELP pi_context_static_tokens Estimated tokens the system prompt and tool schemas cost on every turn (chars/4).");
		L.push("# TYPE pi_context_static_tokens gauge");
		// The true total, deliberately untouched by the top-N cap below.
		line("pi_context_static_tokens", state.footprint.total);
	}

	const mode = attributionMode();
	const topN = attributionTopN();

	if (mode !== "off" && state.footprint) {
		L.push("# HELP pi_context_footprint_tokens Static context footprint split by what caused it (chars/4 estimate).");
		L.push("# TYPE pi_context_footprint_tokens gauge");
		for (const p of seriesFor(state.footprint.parts, mode, topN)) {
			line("pi_context_footprint_tokens", p.tokens, {
				kind: p.kind,
				name: p.name,
				source: p.source,
			});
		}
	}

	if (mode !== "off") {
		L.push("# HELP pi_source_tokens_total Tokens ingested at runtime, by source. A skill read counts under both kind=tool and kind=skill, so sum by kind, never across.");
		L.push("# TYPE pi_source_tokens_total counter");
		for (const p of seriesFor([...state.sourceTokens.values()], mode, topN)) {
			line("pi_source_tokens_total", p.tokens, { kind: p.kind, name: p.name, source: p.source });
		}
	}

	L.push("# HELP pi_tool_nested_tokens_total Tokens spent by sub-agents inside a tool, when the tool reports usage.");
	L.push("# TYPE pi_tool_nested_tokens_total counter");
	for (const [key, v] of state.nestedTokens) {
		const [tool, type] = key.split(KEY_SEP);
		line("pi_tool_nested_tokens_total", v, { tool, type });
	}

	L.push("# HELP pi_tool_nested_cost_usd_total Cost in USD of sub-agent work inside a tool, when the tool reports usage.");
	L.push("# TYPE pi_tool_nested_cost_usd_total counter");
	for (const [tool, v] of state.nestedCost) line("pi_tool_nested_cost_usd_total", v, { tool });

	if (state.contextTokens !== null) {
		L.push("# HELP pi_context_tokens Estimated tokens currently in context.");
		L.push("# TYPE pi_context_tokens gauge");
		line("pi_context_tokens", state.contextTokens);
	}
	if (state.contextWindow !== null) {
		L.push("# HELP pi_context_window_tokens Context window of the active model.");
		L.push("# TYPE pi_context_window_tokens gauge");
		line("pi_context_window_tokens", state.contextWindow);
	}

	L.push("# HELP pi_turn_duration_seconds Duration of agent turns.");
	L.push("# TYPE pi_turn_duration_seconds histogram");
	let cum = 0;
	TURN_BUCKETS.forEach((le, i) => {
		cum += state.turnBucketCounts[i];
		line("pi_turn_duration_seconds_bucket", cum, { le: String(le) });
	});
	line("pi_turn_duration_seconds_bucket", state.turnDurationCount, { le: "+Inf" });
	line("pi_turn_duration_seconds_sum", state.turnDurationSum);
	line("pi_turn_duration_seconds_count", state.turnDurationCount);

	return L.join("\n") + "\n";
}

function targetFile(): string {
	return path.join(TARGETS_DIR, `${process.pid}.json`);
}

function writeTargetFile(port: number, state: State): void {
	fs.mkdirSync(TARGETS_DIR, { recursive: true });
	const body = {
		targets: [`127.0.0.1:${port}`],
		labels: { session_id: state.sessionId, cwd: state.cwd, pid: String(process.pid) },
	};
	// file_sd readers tolerate partial reads badly; write-then-rename is atomic
	const tmp = targetFile() + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify([body], null, 1));
	fs.renameSync(tmp, targetFile());
}

function removeTargetFile(): void {
	try {
		fs.unlinkSync(targetFile());
	} catch {
		/* already gone */
	}
}

/**
 * Signal 0 only probes; the error tells us what the pid is doing. ESRCH is the
 * one answer that means gone. EPERM means very much alive, just owned by
 * another user, and anything else means we do not know — so we keep the target.
 * `kill` is injectable for the unit test.
 */
export function isAlive(
	pid: number,
	kill: (pid: number, signal: number) => void = (p, s) => process.kill(p, s),
): boolean {
	try {
		kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

// A crash between writeFileSync and renameSync leaves a <pid>.json.tmp behind.
// Reap it, but only once it has sat still long enough that no live rename can
// be in flight over it.
const TMP_MAX_AGE_MS = 60_000;

function cleanStaleTargets(): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(TARGETS_DIR);
	} catch {
		return;
	}
	const now = Date.now();
	for (const name of entries) {
		const isTmp = name.endsWith(".json.tmp");
		if (!isTmp && !name.endsWith(".json")) continue;
		const pid = Number.parseInt(name, 10);
		if (Number.isNaN(pid) || pid === process.pid) continue;
		if (isAlive(pid)) continue;
		if (isTmp) {
			let mtimeMs: number;
			try {
				mtimeMs = fs.statSync(path.join(TARGETS_DIR, name)).mtimeMs;
			} catch {
				continue; /* gone already */
			}
			if (now - mtimeMs < TMP_MAX_AGE_MS) continue;
		}
		try {
			fs.unlinkSync(path.join(TARGETS_DIR, name));
		} catch {
			/* raced with another session's cleanup */
		}
	}
}

// ===========================================================================
// Runtime attribution
// ===========================================================================

/** The same accounting as Pi's estimateTextAndImageContentChars. */
export function contentChars(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content as Array<Record<string, unknown>>) {
		if (block?.type === "text" && typeof block.text === "string") chars += block.text.length;
		else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS;
	}
	return chars;
}

export interface NestedUsage {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	cost: number;
}

/**
 * `tool_result.usage` arrived in Pi 0.84. On 0.80 the field is simply absent,
 * and an absent field must produce no series at all rather than a zero one.
 */
export function readNestedUsage(usage: unknown): NestedUsage | null {
	if (!usage || typeof usage !== "object") return null;
	const u = usage as Record<string, unknown>;
	if (typeof u.input !== "number" || typeof u.output !== "number") return null;
	const cost = u.cost as Record<string, unknown> | undefined;
	return {
		input: u.input,
		output: u.output,
		cache_read: typeof u.cacheRead === "number" ? u.cacheRead : 0,
		cache_write: typeof u.cacheWrite === "number" ? u.cacheWrite : 0,
		cost: cost && typeof cost.total === "number" ? cost.total : 0,
	};
}

/** The skill whose directory contains this path, if any. */
export function skillForPath(
	skills: readonly SkillLike[],
	filePath: string,
	cwd: string,
): SkillLike | undefined {
	const abs = path.resolve(cwd, filePath);
	return skills.find(
		(s) => abs === s.filePath || abs === s.baseDir || abs.startsWith(s.baseDir + path.sep),
	);
}

// ===========================================================================
// Wiring
// ===========================================================================

interface ReportEntryData {
	lines: string[];
}

export default function prometheusExporter(pi: ExtensionAPI): void {
	let state = newState();
	let server: http.Server | undefined;
	let port = 0;
	let turnStartedAt = 0;

	function refreshContextGauges(ctx: ExtensionContext): void {
		const usage = ctx.getContextUsage();
		state.contextTokens = usage?.tokens ?? null;
		state.contextWindow = usage?.contextWindow ?? null;
	}

	// Never on message_update, which fires once per token.
	function refreshStatus(ctx: ExtensionContext): void {
		const mode = process.env.PI_PROMETHEUS_STATUS ?? "port";
		if (mode === "off") {
			ctx.ui.setStatus("prometheus", undefined);
			return;
		}
		if (mode === "full") {
			const usage = ctx.getContextUsage();
			const pct = usage?.percent === undefined ? "" : `ctx ${Math.round(usage.percent)}% `;
			ctx.ui.setStatus("prometheus", `${pct}$${state.costUsd.toFixed(2)} :${port}`);
			return;
		}
		ctx.ui.setStatus("prometheus", `metrics :${port}`);
	}

	function ensureServer(ctx: ExtensionContext): void {
		if (server) return;
		server = http.createServer((req, res) => {
			if (req.url === "/metrics") {
				res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
				res.end(renderMetrics(state));
			} else {
				res.writeHead(404);
				res.end();
			}
		});
		server.unref(); // never keep the pi process alive on our account
		server.listen(0, "127.0.0.1", () => {
			port = (server!.address() as { port: number }).port;
			writeTargetFile(port, state);
			refreshStatus(ctx);
		});
	}

	/** getAllTools and getActiveTools landed after 0.80; degrade, do not throw. */
	function allTools(): ToolLike[] {
		return typeof pi.getAllTools === "function" ? (pi.getAllTools() as ToolLike[]) : [];
	}

	function activeToolNames(options?: BuildSystemPromptOptions): string[] {
		if (typeof pi.getActiveTools === "function") {
			const active = pi.getActiveTools();
			if (active.length > 0) return active;
		}
		// selectedTools undefined means Pi's default four, never "no tools".
		return options?.selectedTools ?? ["read", "bash", "edit", "write"];
	}

	/** Recompute only when the inputs changed; a repeat turn costs nothing. */
	function updateFootprint(systemPrompt: string, options: BuildSystemPromptOptions): void {
		const tools = allTools();
		const skills = options.skills as SkillLike[] | undefined;
		const input: FootprintInput = {
			systemPrompt,
			skills,
			contextFiles: options.contextFiles,
			tools,
			activeTools: activeToolNames(options),
		};
		state.skills = skills ?? [];
		state.toolSources = new Map(tools.map((t) => [t.name, sourceOf(t.sourceInfo)]));
		if (state.footprint?.signature === footprintSignature(input)) return;
		state.footprint = computeFootprint(input);
	}

	function creditRuntime(part: FootprintPart): void {
		const key = partKey(part);
		const seen = state.sourceTokens.get(key);
		if (seen) seen.tokens += part.tokens;
		else state.sourceTokens.set(key, { ...part });
	}

	function render(ctx: ExtensionCommandContext, customType: string, lines: string[]): void {
		pi.appendEntry<ReportEntryData>(customType, { lines });
		// A custom entry is invisible outside the TUI, and print or RPC sessions
		// are exactly where someone pipes this into a file.
		if (ctx.mode !== "tui") ctx.ui.notify(lines.filter((l) => l.trim()).join(" | "));
	}

	if (typeof pi.registerEntryRenderer === "function") {
		// A plain object satisfies pi-tui's Component: one render(width) method.
		// Importing the real Box and Text would make pi-tui a runtime dependency.
		for (const customType of ["prometheus-budget", "prometheus-session"]) {
			pi.registerEntryRenderer<ReportEntryData>(customType, (entry) => ({
				render: () => entry.data?.lines ?? [],
			}));
		}
	}

	pi.registerCommand("context-budget", {
		description: "Which tool, skill or package fills the context window (chars/4 estimates)",
		handler: async (_args, ctx) => {
			// before_agent_start only fires when a prompt is submitted, so a
			// session where nothing was typed yet has no footprint to show.
			if (!state.footprint && typeof ctx.getSystemPromptOptions === "function") {
				updateFootprint(ctx.getSystemPrompt(), ctx.getSystemPromptOptions());
			}
			refreshContextGauges(ctx);
			render(
				ctx,
				"prometheus-budget",
				buildBudgetReport({
					footprint: state.footprint,
					runtime: [...state.sourceTokens.values()],
					contextWindow: state.contextWindow,
				}),
			);
		},
	});

	pi.registerCommand("metrics", {
		description: "This session's numbers and the Prometheus scrape endpoint",
		handler: async (_args, ctx) => {
			render(ctx, "prometheus-session", buildSessionReport(state, port));
		},
	});

	pi.on("session_start", (_event, ctx) => {
		// Unconditional: this fires again on /new, resume and fork, and the
		// counters of the session that just ended must not carry over.
		state = newState();
		turnStartedAt = 0;
		state.sessionId = ctx.sessionManager.getSessionId();
		state.cwd = ctx.cwd;
		state.model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
		refreshContextGauges(ctx);
		cleanStaleTargets();
		ensureServer(ctx);
		if (port) {
			writeTargetFile(port, state); // session id may have changed (new/resume/fork)
			refreshStatus(ctx);
		}
	});

	pi.on("model_select", (event) => {
		state.model = `${event.model.provider}/${event.model.id}`;
	});

	// Fired on the common prompt path (agent-session.js:888), so TUI, print and
	// RPC all reach it.
	pi.on("before_agent_start", (event) => {
		updateFootprint(event.systemPrompt, event.systemPromptOptions);
	});

	pi.on("message_end", (event, ctx) => {
		const m = event.message;
		if (m.role !== "assistant") return;
		state.tokens.input += m.usage.input;
		state.tokens.output += m.usage.output;
		state.tokens.cache_read += m.usage.cacheRead;
		state.tokens.cache_write += m.usage.cacheWrite;
		state.costUsd += m.usage.cost.total;
		refreshContextGauges(ctx);
		refreshStatus(ctx);
	});

	pi.on("turn_start", (event) => {
		turnStartedAt = event.timestamp;
	});

	pi.on("turn_end", () => {
		state.turns += 1;
		if (turnStartedAt > 0) {
			const seconds = (Date.now() - turnStartedAt) / 1000;
			state.turnDurationSum += seconds;
			state.turnDurationCount += 1;
			const i = TURN_BUCKETS.findIndex((le) => seconds <= le);
			if (i >= 0) state.turnBucketCounts[i] += 1;
			turnStartedAt = 0;
		}
	});

	pi.on("tool_execution_end", (event) => {
		state.toolCalls.set(event.toolName, (state.toolCalls.get(event.toolName) ?? 0) + 1);
		if (event.isError) {
			state.toolErrors.set(event.toolName, (state.toolErrors.get(event.toolName) ?? 0) + 1);
		}
	});

	pi.on("tool_result", (event, ctx) => {
		const tokens = estimateTokens(contentChars(event.content));
		if (tokens > 0) {
			creditRuntime({
				kind: "tool",
				name: event.toolName,
				source: state.toolSources.get(event.toolName) ?? UNKNOWN_SOURCE,
				tokens,
			});
			// A read under a skill's directory is that skill's dynamic cost, the
			// half progressive disclosure keeps out of the system prompt.
			const readPath = event.toolName === "read" ? event.input?.path : undefined;
			if (typeof readPath === "string") {
				const skill = skillForPath(state.skills, readPath, ctx.cwd);
				if (skill) {
					creditRuntime({
						kind: "skill",
						name: skill.name,
						source: sourceOf(skill.sourceInfo),
						tokens,
					});
				}
			}
		}

		const usage = readNestedUsage(event.usage);
		if (!usage) return;
		for (const type of ["input", "output", "cache_read", "cache_write"] as const) {
			const key = `${event.toolName}${KEY_SEP}${type}`;
			state.nestedTokens.set(key, (state.nestedTokens.get(key) ?? 0) + usage[type]);
		}
		state.nestedCost.set(event.toolName, (state.nestedCost.get(event.toolName) ?? 0) + usage.cost);
	});

	pi.on("session_compact", (event, ctx) => {
		state.compactions.set(event.reason, (state.compactions.get(event.reason) ?? 0) + 1);
		refreshContextGauges(ctx);
		refreshStatus(ctx);
	});

	pi.on("session_compact_failed", (event) => {
		state.compactionFailures.set(event.reason, (state.compactionFailures.get(event.reason) ?? 0) + 1);
	});

	pi.on("session_shutdown", () => {
		removeTargetFile();
		server?.close();
		server = undefined;
	});
}
