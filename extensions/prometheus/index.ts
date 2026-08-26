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
 * PI_PROMETHEUS_ATTRIBUTION_TOP_N   named series kept      (default 100)
 * PI_PROMETHEUS_STATUS              off | port | full      (default port)
 *
 * This file is the extension entry point Pi loads, and the only one that
 * touches the ExtensionAPI. The four modules beside it are pure: attribution
 * computes the footprint, report renders the two terminal tables, exposition
 * holds session state and the Prometheus text format, targets owns the
 * file_sd lifecycle. None of them imports Pi, so the test suite drives them
 * with no running Pi.
 */
import type {
	BuildSystemPromptOptions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as http from "node:http";
import {
	computeFootprint,
	contentChars,
	estimateTokens,
	footprintSignature,
	KEY_SEP,
	partKey,
	readNestedUsage,
	skillForPath,
	sourceOf,
	UNKNOWN_SOURCE,
} from "./attribution.ts";
import type { FootprintInput, FootprintPart, SkillLike, ToolLike } from "./attribution.ts";
import { newState, renderMetrics, TURN_BUCKETS } from "./exposition.ts";
import { buildBudgetReport, buildSessionReport } from "./report.ts";
import { cleanStaleTargets, removeTargetFile, writeTargetFile } from "./targets.ts";

// The public surface of the package, unchanged by the split: everything that
// used to be exported from extensions/prometheus.ts is still reachable here.
export * from "./attribution.ts";
export * from "./exposition.ts";
export * from "./report.ts";
export * from "./targets.ts";

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
