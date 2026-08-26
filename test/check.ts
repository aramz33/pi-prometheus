/**
 * Self-check: boots the extension with a fake ExtensionAPI, fires the events
 * Pi would fire, and asserts on /metrics output + target-file lifecycle.
 * Run: node test/check.ts
 * PI_PROMETHEUS_DIR is honoured when set, otherwise a temp dir is made here.
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The extension resolves TARGETS_DIR at module load, so the env has to be set
// before the import — hence the dynamic import below rather than a static one.
const DIR = process.env.PI_PROMETHEUS_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-prom-"));
process.env.PI_PROMETHEUS_DIR = DIR;
fs.mkdirSync(DIR, { recursive: true });

// stale target from a dead pid must be cleaned on session_start
const stale = path.join(DIR, "999999999.json");
fs.writeFileSync(stale, "[]");

const { default: factory, isAlive } = await import("../extensions/prometheus.ts");

type Handler = (event: any, ctx: any) => unknown;

/**
 * One factory invocation with its own handler map, the way Pi wires an
 * extension. `server` and `port` are factory-scoped in the extension, so a
 * second invocation binds its own listener; we learn its port from the status
 * line it publishes, since both invocations share the one <pid>.json file.
 */
function newInstance() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as any;
	let boundPort = 0;
	const ctx = {
		cwd: "/tmp/fake-project",
		sessionManager: { getSessionId: () => "sess-test-123" },
		model: { provider: "llamacpp", id: "qwen3.5-4b" },
		getContextUsage: () => ({ tokens: 1234, contextWindow: 16384, percent: 7.5 }),
		ui: {
			setStatus: (_key: string, value: string) => {
				boundPort = Number(value.replace(/\D/g, ""));
			},
		},
	} as any;
	factory(pi);
	return {
		ctx,
		port: () => boundPort,
		async fire(event: string, payload: any): Promise<void> {
			for (const h of handlers.get(event) ?? []) await h(payload, ctx);
		},
	};
}

function targetFilePath(): string {
	return path.join(DIR, `${process.pid}.json`);
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.fail(`timed out waiting for ${what}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function metrics(port: number): Promise<string> {
	return await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
}

function startTimeFrom(body: string): number {
	const m = body.match(/^pi_session_start_time_seconds (\S+)$/m);
	assert.ok(m, `no pi_session_start_time_seconds line\n--- got:\n${body}`);
	return Number(m[1]);
}

/** Every counter and histogram back to its zero value, no per-label series left. */
function assertCountersAreZero(body: string, when: string): void {
	for (const re of [
		/^pi_tokens_total\{type="input"\} 0$/m,
		/^pi_tokens_total\{type="output"\} 0$/m,
		/^pi_tokens_total\{type="cache_read"\} 0$/m,
		/^pi_tokens_total\{type="cache_write"\} 0$/m,
		/^pi_cost_usd_total 0$/m,
		/^pi_turns_total 0$/m,
		/^pi_turn_duration_seconds_count 0$/m,
		/^pi_turn_duration_seconds_sum 0$/m,
		/^pi_turn_duration_seconds_bucket\{le="\+Inf"\} 0$/m,
	]) {
		assert.match(body, re, `${when}: counter not reset\n--- got:\n${body}`);
	}
	for (const family of ["pi_tool_calls_total{", "pi_tool_errors_total{", "pi_compactions_total{"]) {
		assert.ok(!body.includes(family), `${when}: ${family}...} series survived\n--- got:\n${body}`);
	}
}

// --- instance A: the full happy path -----------------------------------------

const a = newInstance();

// defect 2: the start time must be stamped in session_start, not at module load
await sleep(25);
const beforeFirstStart = Date.now() / 1000;
await a.fire("session_start", { type: "session_start", reason: "startup" });
await waitFor(() => fs.existsSync(targetFilePath()), "target file");

assert.ok(!fs.existsSync(stale), "stale target file was not cleaned up");

const sd = JSON.parse(fs.readFileSync(targetFilePath(), "utf8"));
assert.equal(sd[0].labels.session_id, "sess-test-123");
const target: string = sd[0].targets[0];
assert.equal(target, `127.0.0.1:${a.port()}`, "status line port disagrees with the target file");

// simulate a turn: assistant message with usage, two tool calls (one error), compaction
await a.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() - 42_000 });
await a.fire("message_end", {
	type: "message_end",
	message: {
		role: "assistant",
		usage: {
			input: 100, output: 50, cacheRead: 900, cacheWrite: 30,
			totalTokens: 1080, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0125 },
		},
	},
});
await a.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
await a.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "t2", toolName: "edit", result: {}, isError: true });
await a.fire("turn_end", { type: "turn_end", turnIndex: 0 });
await a.fire("session_compact", { type: "session_compact", reason: "threshold" });

const body = await metrics(a.port());

// CI hands this body to `promtool check metrics`. It is the richest one the
// suite produces: every family populated, before any session reset empties them.
if (process.env.PI_PROMETHEUS_DUMP) fs.writeFileSync(process.env.PI_PROMETHEUS_DUMP, body);

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

// --- session reset, half A: same instance, the session is replaced -----------
// Pi caches the extension module per {cwd, generation} and only clears that
// cache on reload, so /new, resume and fork re-enter session_start with the
// previous session's totals still in memory.

const t0 = startTimeFrom(body);

await sleep(5); // so "the clock advanced" is a strict comparison, not a tie
await a.fire("session_start", { type: "session_start", reason: "new" });

const afterNew = await metrics(a.port());
assertCountersAreZero(afterNew, "after session_start reason=new");
assert.ok(
	t0 >= beforeFirstStart,
	`pi_session_start_time_seconds is module-load time, not session time (${t0} < ${beforeFirstStart})`,
);
assert.ok(
	startTimeFrom(afterNew) > t0,
	`pi_session_start_time_seconds did not advance on the new session (${startTimeFrom(afterNew)} <= ${t0})`,
);

// --- session reset, half B: module evaluated once, factory called twice ------
// This is Pi's real cache behaviour: the module is imported once and the cached
// factory is re-invoked with a fresh handler map. A module-level state object
// survives that, a factory-local one does not.

const b = newInstance();
await b.fire("session_start", { type: "session_start", reason: "startup" });
await waitFor(() => b.port() > 0, "second instance port");
assert.notEqual(b.port(), a.port(), "the second instance did not bind its own server");

assertCountersAreZero(await metrics(b.port()), "second factory invocation");

// and the two instances must not share a counter: a turn on B leaves A at zero
await b.fire("message_end", {
	type: "message_end",
	message: {
		role: "assistant",
		usage: {
			input: 7, output: 0, cacheRead: 0, cacheWrite: 0,
			totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	},
});
assert.match(await metrics(b.port()), /^pi_tokens_total\{type="input"\} 7$/m, "instance B did not record its own turn");
assertCountersAreZero(await metrics(a.port()), "instance A after a turn on instance B");

// --- .tmp orphan reaping -----------------------------------------------------
// A crash between writeFileSync and renameSync leaves <pid>.json.tmp behind.
// It is reaped under the same liveness rule, plus an age guard so a file that
// another process is renaming right now is never taken away from it.

const oldTmp = path.join(DIR, "999999998.json.tmp");
const freshTmp = path.join(DIR, "999999997.json.tmp");
fs.writeFileSync(oldTmp, "[]");
fs.writeFileSync(freshTmp, "[]");
const longAgo = (Date.now() - 5 * 60_000) / 1000;
fs.utimesSync(oldTmp, longAgo, longAgo);

await a.fire("session_start", { type: "session_start", reason: "startup" });
assert.ok(!fs.existsSync(oldTmp), "an old .tmp orphan of a dead pid was not reaped");
assert.ok(fs.existsSync(freshTmp), "a .tmp younger than the age guard was reaped");
fs.unlinkSync(freshTmp);

// --- isAlive decision table --------------------------------------------------

const throwing = (code: string) => () => {
	const err = new Error(code) as NodeJS.ErrnoException;
	err.code = code;
	throw err;
};
assert.equal(isAlive(1234, () => {}), true, "no throw means alive, keep");
assert.equal(isAlive(1234, throwing("ESRCH")), false, "ESRCH means gone, delete");
assert.equal(isAlive(1234, throwing("EPERM")), true, "EPERM means alive under another user, keep");
assert.equal(isAlive(1234, throwing("EINVAL")), true, "an unknown error means unknown, keep");

// --- shutdown ----------------------------------------------------------------

await a.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
assert.ok(!fs.existsSync(targetFilePath()), "target file not removed on shutdown");

// a second shutdown (Pi can fire it on quit after an error path) must not throw
await a.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
await b.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
await b.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });

console.log("OK — all checks passed");
process.exit(0);
