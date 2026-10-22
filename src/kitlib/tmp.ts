/**
 * kitlib tmp: the kit's one owned-temp-dir primitive for TypeScript (ompkit-41l85, KITLIB-TMP v1).
 *
 * J-2026-10-22-06: 77,299 leaked temp dirs (88 GB) came from kit tests and
 * scripts that made a temp dir and never removed it, or removed it only on a
 * normal exit. `ownedTmp()` is the TypeScript third of a three-language
 * contract; `scripts/kitlib_tmp.py` and `scripts/kitlib-tmp.sh` are the other
 * two, and all three pass the one conformance corpus
 * `tests/fixtures/kitlib-tmp/corpus.json` (`tests/cli/kitlib-tmp.test.ts`,
 * `tests/scripts/kitlib_tmp_test.py`).
 *
 * The dir is `<root>/<label>.<pid>.<6 random [a-z0-9]>`, mode 0700; `root`
 * defaults to `os.tmpdir()` (which honours TMPDIR) and must already exist.
 * Labels match `^[a-z0-9][a-z0-9-]{0,47}$`. The dir holds a `.owner` (mode
 * 0600) in the key=value owner-record form `src/scratch.ts` `parseOwnerFile`
 * accepts: `pid`, `label`, `repo` (the creating process's working directory),
 * `created` (ISO time) and, when given, `bead`. That is the identity-free
 * owner field set: `process_start` would cost a `ps` spawn per dir, and the
 * reaper already treats a dead pid with an identity-free owner as reapable
 * and a live one as live unless the pid was reused after `created`.
 *
 * `cleanup()` removes the tree and is a no-op the second time. If removal
 * fails (a 0555 dir inside, as installs make `releases/<v>`), every real dir
 * inside the owned dir is given owner rwx (symlinks are never followed) and
 * removal is retried once; `cleanup()` throws if that fails too, the
 * registry hooks never throw. A per-process
 * registry removes every live dir on `process.on("exit")` and on SIGHUP,
 * SIGINT and SIGTERM; after a signal's cleanup, if no other listener for it
 * remains this module removes its own and re-sends the signal, so the default
 * action still ends the process with that signal. SIGKILL cannot be caught:
 * the dir survives with its `.owner`, which is what the reaper reads. A temp
 * FILE goes inside an owned dir; there is no separate file API.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface OwnedTmp {
	/** Absolute path of the owned directory. */
	readonly path: string;
	/** Removes the directory tree; idempotent. Throws if the tree still cannot be removed. */
	cleanup(): void;
}

export const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** Same accept set as the owner parser's `bead` field (src/scratch.ts AGENT_PATTERN). */
const BEAD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const CREATE_ATTEMPTS = 16;
const HOOKED_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

const liveDirs = new Set<string>();
let hooksInstalled = false;

/** Gives the owner rwx on `dir` and every real directory under it; symlinks are never followed or changed. */
function makeDirsWritable(dir: string): void {
	const stat = lstatSync(dir, { throwIfNoEntry: false });
	if (stat === undefined || !stat.isDirectory()) return;
	chmodSync(dir, (stat.mode & 0o7777) | 0o700);
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) makeDirsWritable(join(dir, entry.name));
	}
}

/** Removes the tree at `dir`. A tree holding a non-writable dir (an install's 0555 `releases/<v>`) cannot be
 * emptied, so on failure every dir inside is made owner-writable and the removal is tried once more. */
function removeTree(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		makeDirsWritable(dir);
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Removes every directory an `ownedTmp()` call still owns; best effort, so one failure never stops the rest. */
export function cleanupAllOwnedTmp(): void {
	for (const dir of liveDirs) {
		try {
			removeTree(dir);
			liveDirs.delete(dir);
		} catch { /* left with its .owner for the reaper */ }
	}
}

function onSignal(signal: NodeJS.Signals): void {
	cleanupAllOwnedTmp();
	if (process.listenerCount(signal) > 1) return;
	process.removeListener(signal, onSignal);
	process.kill(process.pid, signal);
}

function installHooks(): void {
	if (hooksInstalled) return;
	hooksInstalled = true;
	process.on("exit", cleanupAllOwnedTmp);
	for (const signal of HOOKED_SIGNALS) process.on(signal, onSignal);
}

function suffix(): string {
	let out = "";
	while (out.length < 6) {
		for (const byte of randomBytes(8)) {
			if (byte < 252 && out.length < 6) out += SUFFIX_ALPHABET[byte % 36];
		}
	}
	return out;
}

function ownerRepo(): string {
	try {
		const cwd = process.cwd();
		return /[\t\r\n]/.test(cwd) ? "/" : cwd;
	} catch {
		return "/";
	}
}

export function ownedTmp(label: string, opts: { root?: string; bead?: string } = {}): OwnedTmp {
	if (typeof label !== "string" || !LABEL_PATTERN.test(label)) throw new Error(`kitlib tmp: label '${String(label)}' is invalid; want ^[a-z0-9][a-z0-9-]{0,47}$`);
	if (opts.bead !== undefined && !BEAD_PATTERN.test(opts.bead)) throw new Error(`kitlib tmp: bead '${opts.bead}' is invalid; want 1-64 chars of A-Za-z0-9._-`);
	const root = opts.root ?? tmpdir();
	if (!statSync(root).isDirectory()) throw new Error(`kitlib tmp: root '${root}' is not a directory`);
	installHooks();
	let path = "";
	for (let attempt = 0; path === ""; attempt++) {
		const candidate = join(root, `${label}.${process.pid}.${suffix()}`);
		try {
			mkdirSync(candidate, { mode: 0o700 });
			path = candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt + 1 >= CREATE_ATTEMPTS) throw error;
		}
	}
	liveDirs.add(path);
	const lines = [`pid=${process.pid}`, `label=${label}`, `repo=${ownerRepo()}`, `created=${new Date().toISOString()}`];
	if (opts.bead !== undefined) lines.push(`bead=${opts.bead}`);
	try {
		chmodSync(path, 0o700);
		writeFileSync(join(path, ".owner"), `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		chmodSync(join(path, ".owner"), 0o600);
	} catch (error) {
		rmSync(path, { recursive: true, force: true });
		liveDirs.delete(path);
		throw error;
	}
	return {
		path,
		cleanup(): void {
			removeTree(path);
			liveDirs.delete(path);
		},
	};
}
