import { chmodSync, lstatSync } from "node:fs";

/**
 * The private state root must be a real directory owned by the current user with no group/other bits
 * (mutations.ts safeState). Installs made by the pre-CLI scripts created it 0755, which made every receipt
 * command refuse with a generic STATE_UNSAFE. This names the exact problem and repairs only the mode.
 */
export type StateRootIssue = Readonly<{
	path: string;
	problem: "MODE" | "OWNER" | "SYMLINK" | "NOT_DIRECTORY";
	mode: string;
	expected: "0700";
}>;

const octal = (mode: number) => `0${(mode & 0o777).toString(8)}`;

/** Absent is fine (created 0700 on first use); unreadable metadata is reported as NOT_DIRECTORY. */
export function inspectStateRoot(path: string): StateRootIssue | null {
	let stat;
	try { stat = lstatSync(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		return { path, problem: "NOT_DIRECTORY", mode: "unknown", expected: "0700" };
	}
	const mode = octal(stat.mode);
	if (stat.isSymbolicLink()) return { path, problem: "SYMLINK", mode, expected: "0700" };
	if (!stat.isDirectory()) return { path, problem: "NOT_DIRECTORY", mode, expected: "0700" };
	if (stat.uid !== process.getuid?.()) return { path, problem: "OWNER", mode, expected: "0700" };
	if ((stat.mode & 0o077) !== 0) return { path, problem: "MODE", mode, expected: "0700" };
	return null;
}

/** Only a MODE problem on an owned, real directory is repairable; contents are never touched. */
export function repairStateRootMode(path: string): Readonly<{ path: string; previous_mode: string; mode: "0700" }> {
	const issue = inspectStateRoot(path);
	if (!issue) throw new Error("STATE_ROOT_ALREADY_SAFE");
	if (issue.problem !== "MODE") throw new Error(`STATE_ROOT_${issue.problem}`);
	chmodSync(path, 0o700);
	const after = inspectStateRoot(path);
	if (after) throw new Error("STATE_ROOT_REPAIR_FAILED");
	return { path, previous_mode: issue.mode, mode: "0700" };
}
