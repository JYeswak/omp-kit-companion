import { mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../src/kitlib/run.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const UNPINNED_FIXTURE = join(REPO_ROOT, "tests", "fixtures", "br-init", "unpinned.sh");

type BeadsSnapshot = {
	directoryMtimeMs: number;
	entries: Array<{ name: string; mtimeMs: number; size: number }>;
};

export type ParentTracker = {
	dir: string;
	db: string;
	snapshot: () => BeadsSnapshot;
};

function withoutBeadsDb(): Record<string, string> {
	const env = { ...process.env } as Record<string, string>;
	delete env.BEADS_DB;
	return env;
}

function snapshotBeads(dir: string): BeadsSnapshot {
	const beads = join(dir, ".beads");
	return {
		directoryMtimeMs: statSync(beads).mtimeMs,
		entries: readdirSync(beads).sort().map(name => {
			const entry = statSync(join(beads, name));
			return { name, mtimeMs: entry.mtimeMs, size: entry.size };
		}),
	};
}

export async function createParentTracker(root: string, name: string): Promise<ParentTracker> {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	const initialized = await run(["br", "init", "--db", join(dir, ".beads", "beads.db")], {
		cwd: dir,
		deadline_s: 60,
		env: withoutBeadsDb(),
	});
	if (initialized.rc !== 0) {
		throw new Error(`isolated parent br init -> ${initialized.rc}: ${new TextDecoder().decode(initialized.stderr)}`);
	}
	return { dir, db: join(dir, ".beads", "beads.db"), snapshot: () => snapshotBeads(dir) };
}

export async function runUnpinnedInitControl(root: string, name: string): Promise<{
	rc: number | null;
	parentChanged: boolean;
	newLocks: string[];
}> {
	const parent = await createParentTracker(root, `${name}-parent`);
	const before = parent.snapshot();
	const child = join(parent.dir, "nested", "child");
	mkdirSync(child, { recursive: true });
	const result = await run(["sh", UNPINNED_FIXTURE], {
		cwd: child,
		deadline_s: 60,
		env: withoutBeadsDb(),
	});
	const after = parent.snapshot();
	const beforeNames = new Set(before.entries.map(entry => entry.name));
	const newLocks = after.entries
		.filter(entry => !beforeNames.has(entry.name) && (entry.name === ".write.lock" || entry.name.startsWith(".br-db-write-")))
		.map(entry => entry.name);
	return {
		rc: result.rc,
		parentChanged: JSON.stringify(after) !== JSON.stringify(before),
		newLocks,
	};
}
