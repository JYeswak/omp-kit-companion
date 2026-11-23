import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * STABLETCC1 (ompkit-ck2av, Joshua 2026-11-23: "i keep approving the omp-kit message - that should be something ya'll handle").
 *
 * macOS keeps its consent to open a network volume (the ovnfs checkouts mount) per client, and for a command-line tool with no
 * app bundle the client is the executable's PATH (the TCC log reads `static code for: identifier <path>, type: 1`). Every
 * launchd job of the kit ran `~/.local/bin/omp-kit service run <job>`, which the kernel resolves to
 * `~/.local/opt/omp-kit/releases/<version>/bin/omp-kit`, so every release was a new client and re-asked. Children inherit the
 * answer of the process launchd started (the log attributes a child's request to that responsible process), so the fix is
 * one executable at one path that never changes: this launcher. It is a copy of the active release binary kept at
 * `<prefix>/service/omp-kit-svc`, replaced in place at every `service install`; the code requirement of the grant
 * (identifier plus the Developer ID team) is the same for every release, so the grant outlives the replacement. When launchd
 * starts it, it starts `<prefix>/bin/omp-kit` (the active release) as a child with the same arguments and environment and
 * forwards signals and the exit status.
 */
export const SERVICE_LAUNCHER_NAME = "omp-kit-svc";

export function installPrefix(home: string, env: Record<string, string | undefined> = process.env): string {
	const configured = env.OMP_KIT_INSTALL_PREFIX;
	return configured !== undefined && isAbsolute(configured) ? configured : join(home, ".local", "opt", "omp-kit");
}

export function serviceLauncherPath(prefix: string): string {
	return join(prefix, "service", SERVICE_LAUNCHER_NAME);
}

/** True when this process was started as the service launcher (its executable is named omp-kit-svc). */
export function isServiceLauncher(executablePath: string): boolean {
	return basename(executablePath) === SERVICE_LAUNCHER_NAME;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface EnsuredLauncher { path: string; changed: boolean; source: string }

/**
 * Make `<prefix>/service/omp-kit-svc` a byte-identical copy of the active release binary. Idempotent: a record next to it
 * names the release binary it was copied from, and an unchanged source, size and record leave it alone. The copy goes to a
 * temporary name in the same directory and is renamed over the launcher, so a running launcher keeps its image and the path
 * is never absent. Throws when there is no active release binary or the copy does not verify.
 */
export function ensureServiceLauncher(prefix: string): EnsuredLauncher {
	const active = join(prefix, "bin", "omp-kit");
	const source = realpathSync(active);
	const releases = realpathSync(join(prefix, "releases"));
	const rel = relative(releases, source);
	if (rel.startsWith("..") || isAbsolute(rel) || basename(source) !== "omp-kit" || basename(dirname(source)) !== "bin") {
		throw new Error(`SERVICE_LAUNCHER_SOURCE_INVALID: ${active} resolves to ${source}, not a release bin/omp-kit under ${releases}`);
	}
	const directory = join(prefix, "service");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const target = join(directory, SERVICE_LAUNCHER_NAME);
	const record = `${target}.source`;
	let current = false;
	try {
		const info = lstatSync(target);
		current = info.isFile() && !info.isSymbolicLink() && info.size === statSync(source).size && (info.mode & 0o111) !== 0
			&& readFileSync(record, "utf8").trim() === source;
	} catch { current = false; }
	if (current) return { path: target, changed: false, source };
	const temporary = join(directory, `.${SERVICE_LAUNCHER_NAME}.${process.pid}.tmp`);
	const temporaryRecord = `${record}.${process.pid}.tmp`;
	try {
		copyFileSync(source, temporary);
		chmodSync(temporary, 0o755);
		if (sha256File(temporary) !== sha256File(source)) throw new Error("SERVICE_LAUNCHER_COPY_MISMATCH: the copied launcher differs from the release binary");
		renameSync(temporary, target);
		writeFileSync(temporaryRecord, `${source}\n`, { mode: 0o600 });
		renameSync(temporaryRecord, record);
	} catch (error) {
		rmSync(temporary, { force: true });
		rmSync(temporaryRecord, { force: true });
		throw error;
	}
	return { path: target, changed: true, source };
}

/** The release the launcher starts: the active release binary, `<prefix>/bin/omp-kit`, beside the launcher's own directory. */
export function launcherChildPath(executablePath: string): string {
	return join(dirname(dirname(resolve(executablePath))), "bin", "omp-kit");
}

/** The launcher's own exit status for a finished child: its code, or 128 plus the signal number when a signal ended it. */
export function launcherExitStatus(code: number, signal: string | null | undefined): number {
	if (signal === null || signal === undefined) return code;
	const number = (osConstants.signals as Record<string, number>)[signal];
	return 128 + (typeof number === "number" ? number : 0);
}

