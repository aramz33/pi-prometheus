/**
 * Per-session state and the Prometheus text exposition.
 *
 * Pure apart from reading two package.json files for the build_info labels; no
 * Pi import, so a test can build a State by hand and scrape it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	attributionMode,
	attributionTopN,
	KEY_SEP,
	seriesFor,
} from "./attribution.ts";
import type { Footprint, FootprintPart, SkillLike } from "./attribution.ts";

// Turn durations on local models routinely reach minutes; buckets are seconds.
export const TURN_BUCKETS = [5, 15, 30, 60, 120, 300, 600];

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
export function newState(): State {
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
		// Two levels up, not one: this file sits in extensions/prometheus/, so the
		// package root is ../../ from here. Move this file and this breaks quietly.
		const here = path.dirname(fileURLToPath(import.meta.url));
		const pkg = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "package.json"), "utf8"));
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

export function renderMetrics(state: State): string {
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
