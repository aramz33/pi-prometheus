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
 * Override the target directory with PI_PROMETHEUS_DIR.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TARGETS_DIR =
	process.env.PI_PROMETHEUS_DIR ?? path.join(os.homedir(), ".pi", "metrics", "targets");

// Turn durations on local models routinely reach minutes; buckets are seconds.
const TURN_BUCKETS = [5, 15, 30, 60, 120, 300, 600];

interface State {
	tokens: { input: number; output: number; cache_read: number; cache_write: number };
	costUsd: number;
	turns: number;
	toolCalls: Map<string, number>;
	toolErrors: Map<string, number>;
	compactions: Map<string, number>;
	turnBucketCounts: number[]; // one per TURN_BUCKETS entry, cumulative rendering at scrape time
	turnDurationSum: number;
	turnDurationCount: number;
	contextTokens: number | null;
	contextWindow: number | null;
	model: string;
	sessionId: string;
	cwd: string;
	startTime: number;
}

const state: State = {
	tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
	costUsd: 0,
	turns: 0,
	toolCalls: new Map(),
	toolErrors: new Map(),
	compactions: new Map(),
	turnBucketCounts: TURN_BUCKETS.map(() => 0),
	turnDurationSum: 0,
	turnDurationCount: 0,
	contextTokens: null,
	contextWindow: null,
	model: "",
	sessionId: "",
	cwd: "",
	startTime: Date.now() / 1000,
};

function esc(v: string): string {
	return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderMetrics(): string {
	const L: string[] = [];
	const line = (name: string, value: number, labels?: Record<string, string>) => {
		const l = labels
			? "{" + Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(",") + "}"
			: "";
		L.push(`${name}${l} ${value}`);
	};

	L.push("# HELP pi_session_info Static info about this Pi session (value is always 1).");
	L.push("# TYPE pi_session_info gauge");
	line("pi_session_info", 1, { model: state.model, cwd: state.cwd });

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

function writeTargetFile(port: number): void {
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

function cleanStaleTargets(): void {
	let entries: string[];
	try {
		entries = fs.readdirSync(TARGETS_DIR);
	} catch {
		return;
	}
	for (const name of entries) {
		const pid = Number.parseInt(name, 10);
		if (!name.endsWith(".json") || Number.isNaN(pid) || pid === process.pid) continue;
		try {
			process.kill(pid, 0); // throws if the process is gone
		} catch {
			try {
				fs.unlinkSync(path.join(TARGETS_DIR, name));
			} catch {
				/* raced with another session's cleanup */
			}
		}
	}
}

export default function prometheusExporter(pi: ExtensionAPI): void {
	let server: http.Server | undefined;
	let port = 0;
	let turnStartedAt = 0;

	function refreshContextGauges(ctx: ExtensionContext): void {
		const usage = ctx.getContextUsage();
		state.contextTokens = usage?.tokens ?? null;
		state.contextWindow = usage?.contextWindow ?? null;
	}

	function ensureServer(ctx: ExtensionContext): void {
		if (server) return;
		server = http.createServer((req, res) => {
			if (req.url === "/metrics") {
				res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
				res.end(renderMetrics());
			} else {
				res.writeHead(404);
				res.end();
			}
		});
		server.unref(); // never keep the pi process alive on our account
		server.listen(0, "127.0.0.1", () => {
			port = (server!.address() as { port: number }).port;
			writeTargetFile(port);
			ctx.ui.setStatus("prometheus", `metrics :${port}`);
		});
	}

	pi.on("session_start", (_event, ctx) => {
		state.sessionId = ctx.sessionManager.getSessionId();
		state.cwd = ctx.cwd;
		state.model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
		refreshContextGauges(ctx);
		cleanStaleTargets();
		ensureServer(ctx);
		if (port) writeTargetFile(port); // session id may have changed (new/resume/fork)
	});

	pi.on("model_select", (event) => {
		state.model = `${event.model.provider}/${event.model.id}`;
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

	pi.on("session_compact", (event, ctx) => {
		state.compactions.set(event.reason, (state.compactions.get(event.reason) ?? 0) + 1);
		refreshContextGauges(ctx);
	});

	pi.on("session_shutdown", () => {
		removeTargetFile();
		server?.close();
		server = undefined;
	});
}
