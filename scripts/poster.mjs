/**
 * Builds examples/media/context-budget.png, the gallery image, without a
 * screenshot and without a running Pi.
 *
 * It calls the same exported report builder the /context-budget command calls,
 * wraps the lines it returns in a terminal-styled SVG, and rasterises that SVG
 * in a throwaway container. No npm dependency is added: the package keeps zero
 * runtime dependencies and the only tool involved is Docker.
 *
 *   node scripts/poster.mjs            write examples/media/context-budget.{svg,png}
 *   node scripts/poster.mjs --check    also rasterise twice and compare digests
 *
 * Reproducible by construction: the input below is a fixed table, the layout is
 * derived from it, and nothing reads the clock. Same input, same bytes out.
 */
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildBudgetReport } from "../extensions/prometheus.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "examples", "media");
const SVG_PATH = path.join(OUT_DIR, "context-budget.svg");
const PNG_PATH = path.join(OUT_DIR, "context-budget.png");

/** rsvg-convert 2.40.20 on Alpine, carrying Inconsolata regular and bold. */
const RASTER_IMAGE = "minidocks/librsvg:2.40";
/** Rendered at 2x so the text stays crisp when the gallery scales the card. */
const ZOOM = 2;

// ---------------------------------------------------------------------------
// The data
//
// A representative install, anchored on a real measurement: a 16384 token
// window, a 49923 token static footprint, skills costing 250 to 370 tokens
// each in the <available_skills> block, and base_instructions at 646.
//
// Sources are the four a real machine mixes: two installed packages, Pi's own
// builtins, project files, and `auto`, which is what Pi labels a skill it
// discovered by convention in ~/.pi/agent/skills or .pi/skills rather than
// through a package.
// ---------------------------------------------------------------------------

const MCP = "npm:pi-mcp-adapter";
const WEB = "npm:pi-web-access";
/** Pi's label for a resource found by convention, not installed as a package. */
const AUTO = "auto";

/** [kind, name, source, tokens] */
const PARTS = [
	// The MCP adapter ships one schema per remote operation. This is the story.
	["tool", "m365_mail_search", MCP, 4470],
	["tool", "m365_calendar_events", MCP, 4020],
	["tool", "m365_teams_messages", MCP, 3730],
	["tool", "m365_site_search", MCP, 3520],
	["tool", "m365_files_search", MCP, 3406],
	["tool", "m365_user_lookup", MCP, 2940],
	["tool", "m365_mail_send", MCP, 2710],
	["tool", "m365_contacts_list", MCP, 2180],
	["tool", "m365_drive_upload", MCP, 1965],
	["tool", "m365_group_members", MCP, 1840],
	["tool", "m365_notebook_pages", MCP, 1721],
	["tool", "m365_meeting_notes", MCP, 1457],
	["tool", "m365_presence_get", MCP, 1420],

	["tool", "web_fetch", WEB, 1480],
	["tool", "web_search", WEB, 1120],

	["tool", "bash", "builtin", 845],
	["tool", "edit", "builtin", 720],
	["tool", "read", "builtin", 610],
	["tool", "write", "builtin", 505],
	["tool", "todo_write", "builtin", 430],

	["skill", "m365-triage", MCP, 366],
	["skill", "web-research", WEB, 251],

	// Dropped into ~/.pi/agent/skills by hand, so Pi gives them no package name.
	["skill", "terraform-plan", AUTO, 368],
	["skill", "oncall-runbook", AUTO, 355],
	["skill", "db-migrations", AUTO, 344],
	["skill", "api-contracts", AUTO, 329],
	["skill", "deploy-checklist", AUTO, 312],
	["skill", "k8s-triage", AUTO, 301],
	["skill", "sql-tuning", AUTO, 298],
	["skill", "release-notes", AUTO, 287],
	["skill", "pr-review", AUTO, 276],
	["skill", "perf-budget", AUTO, 264],
	["skill", "incident-review", AUTO, 259],
	["skill", "changelog", AUTO, 253],

	["context_file", "docs/architecture.md", "local", 2130],
	["context_file", "AGENTS.md", "local", 1240],
	["context_file", ".pi/rules/style.md", "local", 480],

	["prompt_section", "base_instructions", "builtin", 646],
	["prompt_section", "available_skills", "builtin", 44],
	["prompt_section", "project_context", "builtin", 31],
];

/** What the same session then read in, credited on tool_result. */
const RUNTIME = [
	["tool", "read", "builtin", 8420],
	["tool", "web_fetch", WEB, 5310],
	["tool", "bash", "builtin", 2140],
	["skill", "deploy-checklist", AUTO, 1290],
];

const CONTEXT_WINDOW = 16384;

const toParts = (rows) => rows.map(([kind, name, source, tokens]) => ({ kind, name, source, tokens }));

const parts = toParts(PARTS);
const runtime = toParts(RUNTIME);
const total = parts.reduce((n, p) => n + p.tokens, 0);

const lines = buildBudgetReport({
	footprint: { parts, total, signature: "poster" },
	runtime,
	contextWindow: CONTEXT_WINDOW,
});

// The headline is derived from the same table, never typed by hand.
const bySource = new Map();
for (const p of parts) bySource.set(p.source, (bySource.get(p.source) ?? 0) + p.tokens);
const [topSource, topTokens] = [...bySource].sort((a, b) => b[1] - a[1])[0];
const headline = `${topSource} fills ${((100 * topTokens) / total).toFixed(1)}% of the static context`;
const subline = `${total} tokens on every turn, ${(total / CONTEXT_WINDOW).toFixed(1)}x the ${CONTEXT_WINDOW} token window`;

// ---------------------------------------------------------------------------
// The SVG
// ---------------------------------------------------------------------------

const FONT = "Inconsolata, 'DejaVu Sans Mono', 'Liberation Mono', Menlo, ui-monospace, monospace";
const FONT_SIZE = 20;
/** Inconsolata advances half an em. Only used to size the canvas. */
const CHAR_W = FONT_SIZE * 0.5;
const LINE_H = 28;
const MARGIN = 28;
const PAD_X = 34;
const BAR_H = 46;
const HEAD_H = 122;
const PAD_BOTTOM = 30;

const COL = {
	page: "#05070a",
	card: "#0d1117",
	bar: "#161b22",
	edge: "#272e38",
	text: "#c9d1d9",
	dim: "#6e7681",
	rule: "#30363d",
	head: "#58a6ff",
	hot: "#e3b341",
	bright: "#f0f6fc",
};

const xmlEscape = (s) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const cols = Math.max(76, ...lines.map((l) => l.length));
const bodyW = Math.ceil(cols * CHAR_W);
const cardW = bodyW + 2 * PAD_X;
const cardH = BAR_H + HEAD_H + lines.length * LINE_H + PAD_BOTTOM;
const W = cardW + 2 * MARGIN;
const H = cardH + 2 * MARGIN;

/** Colour is presentation only: the text of every line is the builder's. */
function classOf(line) {
	if (/^-+$/.test(line)) return { fill: COL.rule };
	if (line === "context budget") return { fill: COL.head, weight: "bold" };
	if (/(share|tokens)$/.test(line) && !/%$/.test(line)) return { fill: COL.head, weight: "bold" };
	if (/^static footprint/.test(line)) return { fill: COL.bright, weight: "bold" };
	if (/^(estimates only|tool schemas|prompt is counted)/.test(line)) return { fill: COL.dim };
	if (line.includes(topSource)) return { fill: COL.hot };
	if (/^(\.\.\. and|nothing ingested)/.test(line)) return { fill: COL.dim };
	return { fill: COL.text };
}

const body = lines
	.map((line, i) => {
		if (line.trim() === "") return "";
		const { fill, weight } = classOf(line);
		const y = MARGIN + BAR_H + HEAD_H + i * LINE_H;
		const w = weight ? ` font-weight="bold"` : "";
		return `  <text xml:space="preserve" x="${MARGIN + PAD_X}" y="${y}" fill="${fill}"${w}>${xmlEscape(line)}</text>`;
	})
	.filter(Boolean)
	.join("\n");

const dots = ["#ff5f56", "#ffbd2e", "#27c93f"]
	.map((c, i) => `  <circle cx="${MARGIN + 24 + i * 20}" cy="${MARGIN + BAR_H / 2}" r="6" fill="${c}"/>`)
	.join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" font-size="${FONT_SIZE}">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${COL.page}"/>
  <rect x="${MARGIN}" y="${MARGIN}" width="${cardW}" height="${cardH}" rx="12" fill="${COL.card}" stroke="${COL.edge}"/>
  <path d="M ${MARGIN} ${MARGIN + 12} a 12 12 0 0 1 12 -12 h ${cardW - 24} a 12 12 0 0 1 12 12 v ${BAR_H - 12} h ${-cardW} z" fill="${COL.bar}"/>
  <line x1="${MARGIN}" y1="${MARGIN + BAR_H}" x2="${MARGIN + cardW}" y2="${MARGIN + BAR_H}" stroke="${COL.edge}"/>
${dots}
  <text x="${MARGIN + 104}" y="${MARGIN + BAR_H / 2 + 7}" fill="${COL.dim}" font-size="18">pi /context-budget</text>
  <text x="${MARGIN + PAD_X}" y="${MARGIN + BAR_H + 44}" fill="${COL.hot}" font-size="27" font-weight="bold">${xmlEscape(headline)}</text>
  <text x="${MARGIN + PAD_X}" y="${MARGIN + BAR_H + 76}" fill="${COL.dim}" font-size="19">${xmlEscape(subline)}</text>
${body}
</svg>
`;

// The README shows the same report as a code block; --text is where it comes from.
if (process.argv.includes("--text")) {
	console.log(lines.join("\n"));
	process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(SVG_PATH, svg);

// ---------------------------------------------------------------------------
// The raster, in a container that is thrown away on exit
// ---------------------------------------------------------------------------

function rasterise(outName) {
	execFileSync(
		"docker",
		[
			"run", "--rm", "--network", "none",
			"-v", `${OUT_DIR}:/work`, "-w", "/work",
			"--entrypoint", "rsvg-convert",
			RASTER_IMAGE,
			"-z", String(ZOOM), "-b", COL.page,
			"-o", outName, path.basename(SVG_PATH),
		],
		{ stdio: ["ignore", "inherit", "inherit"] },
	);
}

rasterise(path.basename(PNG_PATH));

const png = fs.readFileSync(PNG_PATH);
const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (!png.subarray(0, 8).equals(magic)) throw new Error("not a PNG");
if (png.toString("latin1", 12, 16) !== "IHDR") throw new Error("no IHDR");
const pxW = png.readUInt32BE(16);
const pxH = png.readUInt32BE(20);
if (pxW < 800 || pxH < 600) throw new Error(`suspicious size ${pxW}x${pxH}`);

const digest = crypto.createHash("sha256").update(png).digest("hex");
console.log(`svg  ${SVG_PATH} (${W}x${H})`);
console.log(`png  ${PNG_PATH} ${pxW}x${pxH}, ${png.length} bytes`);
console.log(`     sha256 ${digest}`);

if (process.argv.includes("--check")) {
	rasterise("context-budget.check.png");
	const again = fs.readFileSync(path.join(OUT_DIR, "context-budget.check.png"));
	fs.rmSync(path.join(OUT_DIR, "context-budget.check.png"));
	const same = crypto.createHash("sha256").update(again).digest("hex");
	console.log(same === digest ? "     reproducible: identical bytes" : "     NOT reproducible");
	if (same !== digest) process.exitCode = 1;
}
