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

/**
 * Skill matching runs through path.resolve, so a POSIX literal becomes
 * "D:\\pkg\\..." on Windows while the fixture stays "/pkg/...", and nothing
 * matches. Resolving both sides keeps the fixture native on every platform.
 */
const NP = (p: string) => path.resolve(p);

// The extension resolves TARGETS_DIR at module load, so the env has to be set
// before the import — hence the dynamic import below rather than a static one.
const DIR = process.env.PI_PROMETHEUS_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-prom-"));
process.env.PI_PROMETHEUS_DIR = DIR;
fs.mkdirSync(DIR, { recursive: true });

// stale target from a dead pid must be cleaned on session_start
const stale = path.join(DIR, "999999999.json");
fs.writeFileSync(stale, "[]");

const {
	default: factory,
	buildBudgetReport,
	capParts,
	computeFootprint,
	isAlive,
	readNestedUsage,
	rollupParts,
	skillForPath,
} = await import("../extensions/prometheus/index.ts");

type Handler = (event: any, ctx: any) => unknown;

// --- the system prompt Pi would assemble ------------------------------------
// Written out here in full rather than derived from the extension, so the
// expected token counts below are an independent computation and not a
// restatement of the code under test. The two block wrappers are copied from
// Pi's buildSystemPrompt and formatSkillsForPrompt.

const SKILLS_HEADER =
	"\n\nThe following skills provide specialized instructions for specific tasks.\n" +
	"Use the read tool to load a skill's file when the task matches its description.\n" +
	"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n" +
	"\n" +
	"<available_skills>\n";
const SKILLS_FOOTER = "</available_skills>";
const CTX_HEADER = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
const CTX_FOOTER = "</project_context>\n";

const SKILLS = [
	{
		name: "pdf",
		description: "Fill and read PDF forms",
		filePath: NP("/pkg/skills/pdf/SKILL.md"),
		baseDir: NP("/pkg/skills/pdf"),
		sourceInfo: { source: "npm:pi-skills-pack" },
	},
	{
		name: "docx",
		description: "Edit Word documents in place",
		filePath: NP("/tmp/fake-project/.pi/skills/docx/SKILL.md"),
		baseDir: NP("/tmp/fake-project/.pi/skills/docx"),
		sourceInfo: { source: "local" },
	},
];

const CONTEXT_FILES = [
	{ path: "/tmp/fake-project/PI.md", content: "Tabs, not spaces. Never touch the vendor dir." },
];

// Four configured tools, three active: the fourth exists only to prove that a
// configured-but-inactive tool is never billed to its package.
const TOOLS = [
	{
		name: "read",
		description: "Read the contents of a file",
		parameters: { type: "object", properties: { path: { type: "string" } } },
		sourceInfo: { source: "builtin" },
	},
	{
		name: "bash",
		description: "Run a shell command",
		parameters: { type: "object", properties: { cmd: { type: "string" } } },
		sourceInfo: { source: "builtin" },
	},
	{
		name: "m365_mail",
		description: "Search and send Microsoft 365 mail",
		parameters: { type: "object", properties: { query: { type: "string" }, top: { type: "number" } } },
		sourceInfo: { source: "npm:pi-m365" },
	},
	{
		name: "never_active",
		description: "Configured in settings but not selected for this session",
		parameters: { type: "object", properties: { anything: { type: "string" } } },
		sourceInfo: { source: "npm:pi-unused" },
	},
];
const ACTIVE_TOOLS = ["read", "bash", "m365_mail"];

const skillBlockText = (s: (typeof SKILLS)[number]) =>
	`  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.filePath}</location>\n  </skill>\n`;
const ctxFileText = (f: (typeof CONTEXT_FILES)[number]) =>
	`<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>\n\n`;
const toolSchemaText = (t: (typeof TOOLS)[number]) =>
	JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters });

const BASE_TEXT =
	"You are an expert coding assistant operating inside pi.\n\nAvailable tools:\n" +
	"- read: Read a file\n- bash: Run a command\n\nGuidelines:\n- Be concise in your responses\n";
const SYSTEM_PROMPT =
	BASE_TEXT +
	CTX_HEADER +
	CONTEXT_FILES.map(ctxFileText).join("") +
	CTX_FOOTER +
	SKILLS_HEADER +
	SKILLS.map(skillBlockText).join("") +
	SKILLS_FOOTER;

const tok = (chars: number) => Math.ceil(chars / 4);

const BEFORE_AGENT_START = {
	type: "before_agent_start",
	prompt: "say hello",
	systemPrompt: SYSTEM_PROMPT,
	systemPromptOptions: {
		cwd: "/tmp/fake-project",
		selectedTools: ACTIVE_TOOLS,
		skills: SKILLS,
		contextFiles: CONTEXT_FILES,
	},
};

/**
 * One factory invocation with its own handler map, the way Pi wires an
 * extension. `server` and `port` are factory-scoped in the extension, so a
 * second invocation binds its own listener; we learn its port from the status
 * line it publishes, since both invocations share the one <pid>.json file.
 */
function newInstance(opts: { tools?: any[]; activeTools?: string[] } = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const renderers = new Map<string, Function>();
	const entries: Array<{ customType: string; data: any }> = [];
	const notifications: string[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, options: any) {
			commands.set(name, options.handler);
		},
		registerEntryRenderer(customType: string, renderer: Function) {
			renderers.set(customType, renderer);
		},
		appendEntry(customType: string, data: any) {
			entries.push({ customType, data });
		},
		getAllTools: () => opts.tools ?? TOOLS,
		getActiveTools: () => opts.activeTools ?? ACTIVE_TOOLS,
	} as any;
	let boundPort = 0;
	let lastStatus: string | undefined;
	const ctx = {
		cwd: "/tmp/fake-project",
		mode: "tui",
		sessionManager: { getSessionId: () => "sess-test-123" },
		model: { provider: "llamacpp", id: "qwen3.5-4b" },
		getContextUsage: () => ({ tokens: 1234, contextWindow: 16384, percent: 7.5 }),
		getSystemPrompt: () => SYSTEM_PROMPT,
		getSystemPromptOptions: () => BEFORE_AGENT_START.systemPromptOptions,
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
			setStatus: (_key: string, value: string | undefined) => {
				lastStatus = value;
				// Both status shapes end in ":<port>"; the port is what we need.
				boundPort = Number(value?.match(/:(\d+)$/)?.[1] ?? boundPort);
			},
		},
	} as any;
	factory(pi);
	return {
		ctx,
		entries,
		notifications,
		renderers,
		port: () => boundPort,
		status: () => lastStatus,
		async run(command: string, args = "", override?: any): Promise<void> {
			const handler = commands.get(command);
			assert.ok(handler, `command /${command} was never registered`);
			await handler(args, override ?? ctx);
		},
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

/** Every sample of one family, as {labels, value}, in exposition order. */
function samples(body: string, family: string): Array<{ labels: string; value: number }> {
	const out: Array<{ labels: string; value: number }> = [];
	for (const l of body.split("\n")) {
		if (l.startsWith("#") || !l.startsWith(family)) continue;
		const m = l.match(/^([a-z_]+)(\{[^}]*\})? (\S+)$/);
		if (!m || m[1] !== family) continue;
		out.push({ labels: m[2] ?? "", value: Number(m[3]) });
	}
	return out;
}

/** One label's value out of an exposition label set. */
function labelOf(labels: string, name: string): string {
	return labels.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";
}

/** A family summed by one label, the shape every dashboard panel queries. */
function sumBy(body: string, family: string, label: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const sample of samples(body, family)) {
		const key = labelOf(sample.labels, label);
		out.set(key, (out.get(key) ?? 0) + sample.value);
	}
	return out;
}

const byKey = (m: Map<string, number>) => [...m].sort((x, y) => x[0].localeCompare(y[0]));
const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

function valueOf(body: string, line: RegExp): number {
	const m = body.match(line);
	assert.ok(m, `no line matching ${line}\n--- got:\n${body}`);
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
	for (const family of [
		"pi_tool_calls_total{",
		"pi_tool_errors_total{",
		"pi_compactions_total{",
		"pi_compaction_failures_total{",
		"pi_source_tokens_total{",
		"pi_tool_nested_tokens_total{",
		"pi_tool_nested_cost_usd_total{",
		"pi_context_footprint_tokens",
		"pi_context_static_tokens",
	]) {
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

// simulate a turn: a system prompt with skills, a context file and tools, an
// assistant message with usage, two tool calls (one error), two tool results,
// a compaction and a failed one.
await a.fire("before_agent_start", BEFORE_AGENT_START);
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
// a bash result whose sub-agent reported its own usage (Pi 0.84 and later)
await a.fire("tool_result", {
	type: "tool_result",
	toolCallId: "t1",
	toolName: "bash",
	input: { cmd: "ls" },
	content: [{ type: "text", text: "x".repeat(400) }],
	isError: false,
	usage: {
		input: 12, output: 34, cacheRead: 5, cacheWrite: 6,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
	},
});
// a read of a skill body: the dynamic half of progressive disclosure
await a.fire("tool_result", {
	type: "tool_result",
	toolCallId: "t3",
	toolName: "read",
	input: { path: NP("/pkg/skills/pdf/SKILL.md") },
	content: [{ type: "text", text: "y".repeat(800) }],
	isError: false,
});
await a.fire("turn_end", { type: "turn_end", turnIndex: 0 });
await a.fire("session_compact", { type: "session_compact", reason: "threshold" });
await a.fire("session_compact_failed", {
	type: "session_compact_failed",
	reason: "overflow",
	aborted: false,
	willRetry: true,
	fromExtension: false,
});

const body = await metrics(a.port());

// CI hands this body to `promtool check metrics`. It is the richest one the
// suite produces: every family populated, before any session reset empties them.
if (process.env.PI_PROMETHEUS_DUMP) fs.writeFileSync(process.env.PI_PROMETHEUS_DUMP, body);

for (const expected of [
	'pi_session_info{model="llamacpp/qwen3.5-4b",cwd="/tmp/fake-project",session_id="sess-test-123"} 1',
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
	'pi_compaction_failures_total{reason="overflow"} 1',
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

// --- attribution: the exact footprint lines ----------------------------------
// Two skills from different sources, one context file, three active tools of
// which two carry distinct sourceInfo.source.

for (const expected of [
	`pi_context_footprint_tokens{kind="tool",name="read",source="builtin"} ${tok(toolSchemaText(TOOLS[0]).length)}`,
	`pi_context_footprint_tokens{kind="tool",name="bash",source="builtin"} ${tok(toolSchemaText(TOOLS[1]).length)}`,
	`pi_context_footprint_tokens{kind="tool",name="m365_mail",source="npm:pi-m365"} ${tok(toolSchemaText(TOOLS[2]).length)}`,
	`pi_context_footprint_tokens{kind="skill",name="pdf",source="npm:pi-skills-pack"} ${tok(skillBlockText(SKILLS[0]).length)}`,
	`pi_context_footprint_tokens{kind="skill",name="docx",source="local"} ${tok(skillBlockText(SKILLS[1]).length)}`,
	`pi_context_footprint_tokens{kind="context_file",name="/tmp/fake-project/PI.md",source="local"} ${tok(ctxFileText(CONTEXT_FILES[0]).length)}`,
	`pi_context_footprint_tokens{kind="prompt_section",name="available_skills",source="builtin"} ${tok(SKILLS_HEADER.length + SKILLS_FOOTER.length)}`,
	`pi_context_footprint_tokens{kind="prompt_section",name="project_context",source="builtin"} ${tok(CTX_HEADER.length + CTX_FOOTER.length)}`,
	`pi_context_footprint_tokens{kind="prompt_section",name="base_instructions",source="builtin"} ${tok(BASE_TEXT.length)}`,
]) {
	assert.ok(body.includes(expected), `missing footprint line: ${expected}\n--- got:\n${body}`);
}

// a tool that is configured but not active was never sent, so it is never billed
assert.ok(
	!body.includes('name="never_active"'),
	`a configured-but-inactive tool was attributed\n--- got:\n${body}`,
);

// the parts must sum to the declared static total, or the table lies
const footprintSamples = samples(body, "pi_context_footprint_tokens");
assert.equal(footprintSamples.length, 9, "unexpected number of footprint series");
const staticTotal = valueOf(body, /^pi_context_static_tokens (\S+)$/m);
assert.equal(
	footprintSamples.reduce((n, s) => n + s.value, 0),
	staticTotal,
	`footprint parts do not sum to pi_context_static_tokens\n--- got:\n${body}`,
);

// runtime attribution: the bash result by its source, the skill read under both
// kind=tool and kind=skill, because the same bytes are both
for (const expected of [
	'pi_source_tokens_total{kind="tool",name="bash",source="builtin"} 100',
	'pi_source_tokens_total{kind="tool",name="read",source="builtin"} 200',
	'pi_source_tokens_total{kind="skill",name="pdf",source="npm:pi-skills-pack"} 200',
	'pi_tool_nested_tokens_total{tool="bash",type="input"} 12',
	'pi_tool_nested_tokens_total{tool="bash",type="output"} 34',
	'pi_tool_nested_tokens_total{tool="bash",type="cache_read"} 5',
	'pi_tool_nested_tokens_total{tool="bash",type="cache_write"} 6',
	'pi_tool_nested_cost_usd_total{tool="bash"} 0.002',
	"pi_prometheus_build_info{version=",
]) {
	assert.ok(body.includes(expected), `missing metric line: ${expected}\n--- got:\n${body}`);
}
assert.match(body, /^pi_prometheus_build_info\{version="[^"]+",pi_version="[^"]+"\} 1$/m);

// the read tool result carried no usage, so it emitted no nested series at all.
// This is the Pi 0.80 compatibility case: absent must mean absent, not zero.
assert.ok(
	!body.includes('pi_tool_nested_tokens_total{tool="read"'),
	`a tool_result without usage emitted nested series\n--- got:\n${body}`,
);
assert.ok(
	!body.includes('pi_tool_nested_cost_usd_total{tool="read"'),
	`a tool_result without usage emitted a nested cost series\n--- got:\n${body}`,
);

// --- PI_PROMETHEUS_ATTRIBUTION=off -------------------------------------------
// The env is read at render time, so the same live instance answers both ways.
// Off must remove the two labelled families and touch nothing else; the true
// total stays, because it is not an attribution series.

process.env.PI_PROMETHEUS_ATTRIBUTION = "off";
const offBody = await metrics(a.port());
delete process.env.PI_PROMETHEUS_ATTRIBUTION;

assert.ok(!offBody.includes("pi_context_footprint_tokens"), "attribution=off still emits footprint series");
assert.ok(!offBody.includes("pi_source_tokens_total"), "attribution=off still emits source series");
assert.match(offBody, new RegExp(`^pi_context_static_tokens ${staticTotal}$`, "m"), "attribution=off lost the true total");

const withoutAttribution = (b: string) =>
	b
		.split("\n")
		.filter((l) => !l.includes("pi_context_footprint_tokens") && !l.includes("pi_source_tokens_total"))
		.join("\n");
assert.equal(
	offBody,
	withoutAttribution(await metrics(a.port())),
	"attribution=off changed something other than the two attribution families",
);

// --- PI_PROMETHEUS_ATTRIBUTION=rollup ----------------------------------------
// The only unbounded label collapses; kind survives because it is closed.

process.env.PI_PROMETHEUS_ATTRIBUTION = "rollup";
const rollupBody = await metrics(a.port());
delete process.env.PI_PROMETHEUS_ATTRIBUTION;

const rolled = samples(rollupBody, "pi_context_footprint_tokens");
assert.ok(rolled.length > 0 && rolled.every((s) => s.labels.includes('name="_all"')), "rollup kept a name label");
assert.equal(
	rolled.reduce((n, s) => n + s.value, 0),
	staticTotal,
	"the rollup lost tokens on the way",
);

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

// --- top-N cap ---------------------------------------------------------------
// 50 tools over 4 packages, a cap of 5: five named series, and the tail folded
// per (kind, source) rather than into one opaque bucket. The total is still the
// untruncated truth because the tail is folded, not dropped, and so is every
// per-source and per-kind sum, which is the part a global bucket destroyed.

const MANY_TOOLS = Array.from({ length: 50 }, (_, i) => ({
	name: `tool_${String(i).padStart(2, "0")}`,
	description: "x".repeat(10 + i * 7),
	parameters: { type: "object", properties: {} },
	sourceInfo: { source: `npm:pack-${i % 4}` },
}));
const MANY_ACTIVE = MANY_TOOLS.map((t) => t.name);

process.env.PI_PROMETHEUS_ATTRIBUTION_TOP_N = "5";
const c = newInstance({ tools: MANY_TOOLS, activeTools: MANY_ACTIVE });
await c.fire("session_start", { type: "session_start", reason: "startup" });
await waitFor(() => c.port() > 0, "third instance port");
await c.fire("before_agent_start", {
	...BEFORE_AGENT_START,
	systemPromptOptions: { cwd: "/tmp/fake-project", selectedTools: MANY_ACTIVE, skills: [], contextFiles: [] },
	systemPrompt: BASE_TEXT,
});
const capped = await metrics(c.port());
delete process.env.PI_PROMETHEUS_ATTRIBUTION_TOP_N;

if (process.env.PI_PROMETHEUS_DUMP) {
	fs.writeFileSync(`${process.env.PI_PROMETHEUS_DUMP}.folded`, capped);
}

const cappedSamples = samples(capped, "pi_context_footprint_tokens");

// the untruncated total, computed here from the fixtures alone
const untruncated =
	MANY_TOOLS.reduce((n, t) => n + tok(toolSchemaText(t as any).length), 0) + tok(BASE_TEXT.length);
const capTrueBySource = new Map<string, number>();
const capTrueByKind = new Map<string, number>();
for (const t of MANY_TOOLS) {
	const tokens = tok(toolSchemaText(t as any).length);
	bump(capTrueBySource, t.sourceInfo.source, tokens);
	bump(capTrueByKind, "tool", tokens);
}
bump(capTrueBySource, "builtin", tok(BASE_TEXT.length));
bump(capTrueByKind, "prompt_section", tok(BASE_TEXT.length));

// what is true, before what is shaped: the cap never moves the real total
assert.match(
	capped,
	new RegExp(`^pi_context_static_tokens ${untruncated}$`, "m"),
	`the cap moved pi_context_static_tokens\n--- got:\n${capped}`,
);
assert.equal(
	cappedSamples.reduce((n, s) => n + s.value, 0),
	untruncated,
	"the folded tail lost tokens",
);
// and the two aggregates every dashboard panel draws stay exact under the cap
assert.deepEqual(
	byKey(sumBy(capped, "pi_context_footprint_tokens", "source")),
	byKey(capTrueBySource),
	`sum by (source) over the capped series is not the per-source truth\n--- got:\n${capped}`,
);
assert.deepEqual(
	byKey(sumBy(capped, "pi_context_footprint_tokens", "kind")),
	byKey(capTrueByKind),
	`sum by (kind) over the capped series is not the per-kind truth\n--- got:\n${capped}`,
);

// then the shape. The five largest tools stay named; the tail is 45 tools plus
// base_instructions, so it folds into four kind=tool rows, one per package, and
// one kind=prompt_section row: five named series plus five folded ones.
assert.equal(
	cappedSamples.length,
	10,
	`expected 5 named series plus one _other per (kind, source)\n--- got:\n${capped}`,
);
assert.equal(
	cappedSamples.filter((s) => labelOf(s.labels, "name") === "_other").length,
	5,
	`the folded tail is not one _other series per (kind, source)\n--- got:\n${capped}`,
);
assert.ok(
	!capped.includes('kind="other"') && !capped.includes('source="other"'),
	`the tail was folded into one opaque global bucket\n--- got:\n${capped}`,
);
// base_instructions is the only prompt_section here, so its folded row is exact
assert.ok(
	capped.includes(
		`pi_context_footprint_tokens{kind="prompt_section",name="_other",source="builtin"} ${tok(BASE_TEXT.length)}`,
	),
	`the folded row lost its own kind and source\n--- got:\n${capped}`,
);

// --- a session shaped like a real one, at the default cap --------------------
// Hundreds of skills from a handful of packages, which is ordinary. This is the
// case the old global `other` bucket destroyed: at the default cap it swallowed
// 84 percent of the footprint into one anonymous row, and the release's headline
// panel, sum by (source), then had nothing to say. The assertion below is the
// whole point of the fold: the per-source totals survive the cap exactly, even
// though most names do not.

const BIG_SKILL_SOURCES = ["auto", "npm:pi-skills-mega", "local"];
const BIG_SKILLS = Array.from({ length: 250 }, (_, i) => {
	const id = `skill_${String(i).padStart(3, "0")}`;
	return {
		name: id,
		description: "y".repeat(20 + (i % 40) * 5),
		filePath: NP(`/pkg/skills/${id}/SKILL.md`),
		baseDir: NP(`/pkg/skills/${id}`),
		sourceInfo: { source: BIG_SKILL_SOURCES[i % BIG_SKILL_SOURCES.length] },
	};
});
const BIG_TOOLS = [
	{
		name: "read",
		description: "Read the contents of a file",
		parameters: { type: "object", properties: { path: { type: "string" } } },
		sourceInfo: { source: "builtin" },
	},
	...Array.from({ length: 39 }, (_, i) => ({
		name: `mcp_tool_${String(i).padStart(2, "0")}`,
		description: "z".repeat(15 + i * 3),
		parameters: { type: "object", properties: {} },
		sourceInfo: { source: i % 2 === 0 ? "builtin" : "npm:pi-m365" },
	})),
];
const BIG_ACTIVE = BIG_TOOLS.map((t) => t.name);
const BIG_PROMPT =
	BASE_TEXT + SKILLS_HEADER + BIG_SKILLS.map(skillBlockText).join("") + SKILLS_FOOTER;

// no PI_PROMETHEUS_ATTRIBUTION_TOP_N here: this exercises the default
const f = newInstance({ tools: BIG_TOOLS, activeTools: BIG_ACTIVE });
await f.fire("session_start", { type: "session_start", reason: "startup" });
await waitFor(() => f.port() > 0, "sixth instance port");
await f.fire("before_agent_start", {
	...BEFORE_AGENT_START,
	systemPromptOptions: {
		cwd: "/tmp/fake-project",
		selectedTools: BIG_ACTIVE,
		skills: BIG_SKILLS,
		contextFiles: [],
	},
	systemPrompt: BIG_PROMPT,
});
const big = await metrics(f.port());

const bigTrueBySource = new Map<string, number>();
const bigTrueByKind = new Map<string, number>();
for (const sk of BIG_SKILLS) {
	const tokens = tok(skillBlockText(sk).length);
	bump(bigTrueBySource, sk.sourceInfo.source, tokens);
	bump(bigTrueByKind, "skill", tokens);
}
for (const t of BIG_TOOLS) {
	const tokens = tok(toolSchemaText(t as any).length);
	bump(bigTrueBySource, t.sourceInfo.source, tokens);
	bump(bigTrueByKind, "tool", tokens);
}
for (const chars of [SKILLS_HEADER.length + SKILLS_FOOTER.length, BASE_TEXT.length]) {
	bump(bigTrueBySource, "builtin", tok(chars));
	bump(bigTrueByKind, "prompt_section", tok(chars));
}

assert.deepEqual(
	byKey(sumBy(big, "pi_context_footprint_tokens", "source")),
	byKey(bigTrueBySource),
	`sum by (source) lost the truth at the default cap\n--- got:\n${big}`,
);
assert.deepEqual(
	byKey(sumBy(big, "pi_context_footprint_tokens", "kind")),
	byKey(bigTrueByKind),
	`sum by (kind) lost the truth at the default cap\n--- got:\n${big}`,
);

const bigSamples = samples(big, "pi_context_footprint_tokens");
const bigNamed = bigSamples.filter((x) => labelOf(x.labels, "name") !== "_other");
// the default cap, pinned: change the constant and this is what moves
assert.equal(bigNamed.length, 100, `the default cap is not 100 named series\n--- got:\n${big}`);
// three skill packages, two tool packages and Pi's own scaffolding: six folded
// rows, each still saying which package and which kind it stands for
assert.equal(
	bigSamples.length - bigNamed.length,
	6,
	`the tail did not fold per (kind, source)\n--- got:\n${big}`,
);
const bigTotal = [...bigTrueBySource.values()].reduce((n, v) => n + v, 0);
assert.match(
	big,
	new RegExp(`^pi_context_static_tokens ${bigTotal}$`, "m"),
	`the default cap moved pi_context_static_tokens\n--- got:\n${big}`,
);
assert.equal(
	bigSamples.reduce((n, x) => n + x.value, 0),
	bigTotal,
	"the folded tail lost tokens at the default cap",
);

// the terminal report is built from the uncapped parts, so no `_other` reaches
// it and its by-source table is the truth to the token
await f.run("context-budget");
const bigReport: string[] = f.entries[0].data.lines;
assert.ok(!bigReport.some((l) => l.includes("_other")), "the report leaked a folded row");
for (const [source, tokens] of bigTrueBySource) {
	assert.ok(
		bigReport.some((l) => l.startsWith(source) && l.includes(String(tokens))),
		`the report's by-source table lost ${source}\n--- got:\n${bigReport.join("\n")}`,
	);
}

// --- a tool_result with no usage at all, on a clean instance -----------------
// Pi 0.80 has no `usage` on tool_result. Not one nested series may appear.

const d = newInstance();
await d.fire("session_start", { type: "session_start", reason: "startup" });
await waitFor(() => d.port() > 0, "fourth instance port");
await d.fire("before_agent_start", BEFORE_AGENT_START);
await d.fire("tool_result", {
	type: "tool_result",
	toolCallId: "t9",
	toolName: "bash",
	input: { cmd: "ls" },
	content: [{ type: "text", text: "z".repeat(40) }],
	isError: false,
});
const noUsage = await metrics(d.port());
assert.ok(
	!noUsage.includes("pi_tool_nested_tokens_total{"),
	`a tool_result without usage emitted nested tokens\n--- got:\n${noUsage}`,
);
assert.ok(
	!noUsage.includes("pi_tool_nested_cost_usd_total{"),
	`a tool_result without usage emitted a nested cost\n--- got:\n${noUsage}`,
);
// the content itself is still attributed; only the sub-agent numbers are absent
assert.match(noUsage, /^pi_source_tokens_total\{kind="tool",name="bash",source="builtin"\} 10$/m);

// a read outside every skill directory credits the tool and no skill
await d.fire("tool_result", {
	type: "tool_result",
	toolCallId: "t10",
	toolName: "read",
	input: { path: "/tmp/fake-project/src/main.ts" },
	content: [{ type: "text", text: "q".repeat(40) }],
	isError: false,
});
const afterPlainRead = await metrics(d.port());
assert.match(afterPlainRead, /^pi_source_tokens_total\{kind="tool",name="read",source="builtin"\} 10$/m);
assert.ok(
	!afterPlainRead.includes('pi_source_tokens_total{kind="skill"'),
	`a read outside every skill directory was credited to a skill\n--- got:\n${afterPlainRead}`,
);

// --- the commands ------------------------------------------------------------
// /context-budget must work on a session where no prompt was ever submitted,
// because before_agent_start never fired there. It falls back to
// ctx.getSystemPromptOptions(), which only command contexts carry.

const e = newInstance();
await e.fire("session_start", { type: "session_start", reason: "startup" });
await waitFor(() => e.port() > 0, "fifth instance port");
assert.ok(
	!(await metrics(e.port())).includes("pi_context_static_tokens"),
	"a session with no prompt reported a footprint out of nowhere",
);
await e.run("context-budget");
assert.equal(e.entries.length, 1, "/context-budget appended no entry");
assert.equal(e.entries[0].customType, "prometheus-budget");
assert.ok(e.entries[0].data.lines.length > 5, "the budget entry is empty");
assert.equal(e.notifications.length, 0, "notify fired in a TUI session");
assert.match(
	await metrics(e.port()),
	/^pi_context_static_tokens \d+$/m,
	"the on-demand footprint did not reach the exporter",
);

// the renderer is a plain pi-tui Component: one render(width) returning lines
const renderer = e.renderers.get("prometheus-budget");
assert.ok(renderer, "no entry renderer was registered for the budget");
const component = (renderer as Function)({ data: { lines: ["one", "two"] } }, { expanded: false }, {});
assert.deepEqual(component.render(80), ["one", "two"], "the entry renderer does not render its lines");

// outside the TUI the entry is invisible, so a one-line summary is notified too
await e.run("metrics", "", { ...e.ctx, mode: "print" });
assert.equal(e.entries[1].customType, "prometheus-session");
assert.equal(e.notifications.length, 1, "no notification outside the TUI");
assert.ok(e.notifications[0].includes("/metrics"), "the notification omits the scrape endpoint");

// --- footer status -----------------------------------------------------------

process.env.PI_PROMETHEUS_STATUS = "full";
await e.fire("message_end", {
	type: "message_end",
	message: {
		role: "assistant",
		usage: {
			input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
			totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.42 },
		},
	},
});
assert.equal(e.status(), `ctx 8% $0.42 :${e.port()}`, "PI_PROMETHEUS_STATUS=full");

process.env.PI_PROMETHEUS_STATUS = "off";
await e.fire("session_compact", { type: "session_compact", reason: "manual" });
assert.equal(e.status(), undefined, "PI_PROMETHEUS_STATUS=off did not clear the status");

delete process.env.PI_PROMETHEUS_STATUS;
await e.fire("session_compact", { type: "session_compact", reason: "manual" });
assert.equal(e.status(), `metrics :${e.port()}`, "the default status shape changed");

// --- the report builder, with no TUI anywhere --------------------------------

const report = buildBudgetReport({
	footprint: {
		parts: [
			{ kind: "tool", name: "m365_mail", source: "npm:pi-m365", tokens: 600 },
			{ kind: "skill", name: "pdf", source: "npm:pi-skills-pack", tokens: 300 },
			{ kind: "prompt_section", name: "base_instructions", source: "builtin", tokens: 100 },
		],
		total: 1000,
		signature: "x",
	},
	runtime: [{ kind: "skill", name: "pdf", source: "npm:pi-skills-pack", tokens: 4000 }],
	contextWindow: 20000,
});
assert.ok(report.some((l) => /^npm:pi-m365 +1 +600 +60\.0%$/.test(l)), `no per-source row for npm:pi-m365\n${report.join("\n")}`);
assert.ok(report.some((l) => /^tool +m365_mail +npm:pi-m365 +600 +60\.0%$/.test(l)), `no entry row\n${report.join("\n")}`);
assert.ok(report.some((l) => /^skill +pdf +npm:pi-skills-pack +4000 +100\.0%$/.test(l)), `no runtime row\n${report.join("\n")}`);
assert.ok(
	report.includes("static footprint 1000 tokens, 5.0% of the 20000 token window"),
	`no total line\n${report.join("\n")}`,
);
assert.ok(
	report.some((l) => l.includes("chars/4")),
	"the report does not say the numbers are estimates",
);
for (const l of report) {
	assert.ok(l.length <= 80, `report line wider than 80 columns (${l.length}): ${l}`);
}
assert.deepEqual(
	buildBudgetReport({ footprint: null, runtime: [], contextWindow: null })[2],
	"no system prompt seen yet in this session",
);

// --- the pure attribution pieces, called directly ----------------------------

const footprint = computeFootprint({
	systemPrompt: SYSTEM_PROMPT,
	skills: SKILLS,
	contextFiles: CONTEXT_FILES,
	tools: TOOLS,
	activeTools: ACTIVE_TOOLS,
});
assert.equal(
	footprint.parts.reduce((n, p) => n + p.tokens, 0),
	footprint.total,
	"computeFootprint's own parts do not sum to its total",
);
assert.equal(
	footprint.parts.filter((p) => p.kind === "tool").length,
	3,
	"computeFootprint attributed a tool that was not active",
);

// a skill the model cannot invoke is not in the prompt, so it costs nothing
const hidden = computeFootprint({
	systemPrompt: BASE_TEXT,
	skills: [{ ...SKILLS[0], disableModelInvocation: true }],
	tools: [],
	activeTools: ["read"],
});
assert.equal(hidden.parts.filter((p) => p.kind === "skill").length, 0);
assert.equal(hidden.total, tok(BASE_TEXT.length));

// the cap folds rather than drops
const many = Array.from({ length: 10 }, (_, i) => ({
	kind: "tool" as const, name: `t${i}`, source: "builtin", tokens: i + 1,
}));
const cappedParts = capParts(many, 3);
assert.equal(cappedParts.length, 4);
assert.equal(cappedParts.reduce((n, p) => n + p.tokens, 0), 55);
assert.equal(capParts(many, 0).length, 10, "a cap of zero must mean no cap");

// and the fold is per kind and per source, never one bucket for everything
const mixed = [
	{ kind: "tool" as const, name: "big", source: "npm:a", tokens: 100 },
	{ kind: "tool" as const, name: "t1", source: "npm:a", tokens: 3 },
	{ kind: "tool" as const, name: "t2", source: "npm:a", tokens: 2 },
	{ kind: "skill" as const, name: "s1", source: "npm:b", tokens: 5 },
	{ kind: "skill" as const, name: "s2", source: "npm:b", tokens: 4 },
	{ kind: "skill" as const, name: "s3", source: "local", tokens: 1 },
];
assert.deepEqual(
	capParts(mixed, 1),
	[
		{ kind: "tool", name: "big", source: "npm:a", tokens: 100 },
		{ kind: "skill", name: "_other", source: "npm:b", tokens: 9 },
		{ kind: "tool", name: "_other", source: "npm:a", tokens: 5 },
		{ kind: "skill", name: "_other", source: "local", tokens: 1 },
	],
	"the tail did not fold per (kind, source)",
);
assert.equal(rollupParts(many).length, 1, "rollup did not collapse the name label");

// tool_result.usage shapes, the Pi 0.80 guard
assert.equal(readNestedUsage(undefined), null);
assert.equal(readNestedUsage({}), null);
assert.equal(readNestedUsage({ input: 1 }), null);
assert.deepEqual(readNestedUsage({ input: 1, output: 2 }), {
	input: 1, output: 2, cache_read: 0, cache_write: 0, cost: 0,
});

// skill directory matching
assert.equal(skillForPath(SKILLS, NP("/pkg/skills/pdf/reference/forms.md"), NP("/tmp"))?.name, "pdf");
assert.equal(skillForPath(SKILLS, "SKILL.md", NP("/tmp/fake-project/.pi/skills/docx"))?.name, "docx");
assert.equal(skillForPath(SKILLS, NP("/pkg/skills/pdf-other/SKILL.md"), NP("/tmp")), undefined);

// Case folding follows the platform, and only win32 is case insensitive by
// spec. A case insensitive volume on another platform is a filesystem
// property, not a platform one, so folding there could attribute a read to
// the wrong skill on a case sensitive volume.
{
	const shouted = NP("/PKG/SKILLS/PDF/SKILL.MD");
	const hit = skillForPath(SKILLS, shouted, NP("/tmp"))?.name;
	if (process.platform === "win32") {
		assert.equal(hit, "pdf", "win32 is case insensitive, the read was not attributed");
	} else {
		assert.equal(hit, undefined, "this platform is case sensitive, the read must not match");
	}
}

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
for (const inst of [b, c, d, e, f]) {
	await inst.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
	await inst.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
}

console.log("OK — all checks passed");
process.exit(0);
