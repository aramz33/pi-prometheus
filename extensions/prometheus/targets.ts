/**
 * The file_sd target lifecycle: announce this session's port under
 * ~/.pi/metrics/targets/<pid>.json, remove it on shutdown, and reap what dead
 * sessions left behind.
 *
 * No Pi import here either: `State` is a type-only import, erased at runtime.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { State } from "./exposition.ts";

export const TARGETS_DIR =
	process.env.PI_PROMETHEUS_DIR ?? path.join(os.homedir(), ".pi", "metrics", "targets");

export function targetFile(): string {
	return path.join(TARGETS_DIR, `${process.pid}.json`);
}

export function writeTargetFile(port: number, state: State): void {
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

export function removeTargetFile(): void {
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

export function cleanStaleTargets(): void {
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
