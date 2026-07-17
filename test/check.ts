/**
 * Self-check: boots the extension with a fake ExtensionAPI, fires the events
 * Pi would fire, and asserts on /metrics output + target-file lifecycle.
 * Run: PI_PROMETHEUS_DIR=$(mktemp -d) node test/check.ts
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import factory from "../extensions/prometheus.ts";

const DIR = process.env.PI_PROMETHEUS_DIR;
assert.ok(DIR, "run with PI_PROMETHEUS_DIR set to a temp dir");

// stale target from a dead pid must be cleaned on session_start
fs.mkdirSync(DIR, { recursive: true });
const stale = path.join(DIR, "999999999.json");
fs.writeFileSync(stale, "[]");

type Handler = (event: any, ctx: any) => unknown;
const handlers = new Map<string, Handler[]>();
const fakePi = {
	on(event: string, handler: Handler) {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	},
} as any;

const fakeCtx = {
	cwd: "/tmp/fake-project",
	sessionManager: { getSessionId: () => "sess-test-123" },
	model: { provider: "llamacpp", id: "qwen3.5-4b" },
	getContextUsage: () => ({ tokens: 1234, contextWindow: 16384, percent: 7.5 }),
	ui: { setStatus: () => {} },
} as any;

async function fire(event: string, payload: any): Promise<void> {
	for (const h of handlers.get(event) ?? []) await h(payload, fakeCtx);
}

function targetFilePath(): string {
	return path.join(DIR!, `${process.pid}.json`);
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.fail(`timed out waiting for ${what}`);
}

factory(fakePi);

await fire("session_start", { type: "session_start", reason: "startup" });
await waitFor(() => fs.existsSync(targetFilePath()), "target file");

assert.ok(!fs.existsSync(stale), "stale target file was not cleaned up");

const sd = JSON.parse(fs.readFileSync(targetFilePath(), "utf8"));
assert.equal(sd[0].labels.session_id, "sess-test-123");
const target: string = sd[0].targets[0];

// simulate a turn: assistant message with usage, two tool calls (one error), compaction
await fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() - 42_000 });
await fire("message_end", {
	type: "message_end",
	message: {
		role: "assistant",
		usage: {
			input: 100, output: 50, cacheRead: 900, cacheWrite: 30,
			totalTokens: 1080, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0125 },
		},
	},
});
await fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
await fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "t2", toolName: "edit", result: {}, isError: true });
await fire("turn_end", { type: "turn_end", turnIndex: 0 });
await fire("session_compact", { type: "session_compact", reason: "threshold" });

const body = await (await fetch(`http://${target}/metrics`)).text();

for (const expected of [
	'pi_session_info{model="llamacpp/qwen3.5-4b",cwd="/tmp/fake-project"} 1',
	'pi_tokens_total{type="input"} 100',
	'pi_tokens_total{type="output"} 50',
	'pi_tokens_total{type="cache_read"} 900',
	'pi_tokens_total{type="cache_write"} 30',
	"pi_cost_usd_total 0.0125",
	"pi_turns_total 1",
	'pi_tool_calls_total{tool="bash"} 1',
	'pi_tool_calls_total{tool="edit"} 1',
	'pi_tool_errors_total{tool="edit"} 1',
	'pi_compactions_total{reason="threshold"} 1',
	"pi_context_tokens 1234",
	"pi_context_window_tokens 16384",
	'pi_turn_duration_seconds_bucket{le="60"} 1',
	'pi_turn_duration_seconds_bucket{le="30"} 0',
	'pi_turn_duration_seconds_bucket{le="+Inf"} 1',
	"pi_turn_duration_seconds_count 1",
]) {
	assert.ok(body.includes(expected), `missing metric line: ${expected}\n--- got:\n${body}`);
}

// every line must be valid prometheus text format (comment or name{labels} value)
for (const l of body.trim().split("\n")) {
	assert.match(l, /^(#|[a-z_]+(\{[^}]*\})? -?[0-9.eE+-]+$)/, `bad line: ${l}`);
}

await fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
assert.ok(!fs.existsSync(targetFilePath()), "target file not removed on shutdown");

console.log("OK — all checks passed");
process.exit(0);
