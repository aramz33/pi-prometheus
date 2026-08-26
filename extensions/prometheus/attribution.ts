/**
 * Attribution, as pure functions.
 *
 * Everything in this module takes plain data and returns plain data. It imports
 * nothing from Pi, so the test suite drives it with no running Pi — the property
 * that made the suite possible in the first place. Only index.ts touches the
 * ExtensionAPI.
 */
import * as path from "node:path";

/** Closed set. An unbounded `kind` would be a cardinality bomb by itself. */
export type FootprintKind = "tool" | "skill" | "context_file" | "prompt_section";

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

export const UNKNOWN_SOURCE = "unknown";
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

export function sourceOf(info: { source?: string } | undefined): string {
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
export const KEY_SEP = "\u001f";

export function partKey(p: FootprintPart): string {
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

export function byTokensDesc(a: FootprintPart, b: FootprintPart): number {
	return b.tokens - a.tokens || a.name.localeCompare(b.name);
}

/**
 * Keep the top N named series and fold the tail per kind and per source, into
 * `name="_other"` rows. The tail is folded, not dropped, so a sum over the
 * family still lands on the truth; and because only `name` collapses, the two
 * aggregates anyone actually queries, `sum by (source)` and `sum by (kind)`,
 * stay exact however hard the cap bites. A cap of zero or less means no cap.
 *
 * A single global bucket would not: with hundreds of skills installed, which is
 * ordinary, the tail is most of the footprint, and folding it flat renames it
 * to nothing. The added series are bounded by the distinct (kind, source) pairs
 * in the tail, so by the installed packages times four kinds.
 */
export function capParts(parts: readonly FootprintPart[], topN: number): FootprintPart[] {
	const sorted = [...parts].sort(byTokensDesc);
	if (!Number.isFinite(topN) || topN <= 0 || sorted.length <= topN) return sorted;
	const folded = mergeParts(sorted.slice(topN).map((p) => ({ ...p, name: "_other" })));
	return [...sorted.slice(0, topN), ...folded.sort(byTokensDesc)];
}

/**
 * Collapse the only unbounded label. `kind` stays: it is a closed set of four,
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
	// The cap no longer decides whether the numbers are right, only how many
	// rows carry a name, so it can afford to name a whole ordinary install.
	return Number.isFinite(n) ? n : 100;
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
	// Windows paths are case insensitive, and a model routinely emits a drive
	// letter or a separator in the other case than the one Pi recorded. Comparing
	// raw strings there silently attributes a skill read to nothing at all.
	const fold = (v: string) => (process.platform === "win32" ? v.toLowerCase() : v);
	const abs = fold(path.resolve(cwd, filePath));
	return skills.find((s) => {
		const file = fold(s.filePath);
		const base = fold(s.baseDir);
		return abs === file || abs === base || abs.startsWith(base + path.sep);
	});
}
