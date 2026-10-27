/** TOOLSETUP1 (ompkit-fp72.135.1.16): the setup table stays pinned to the doctor's probe list.
 *
 * - Pin: every bin the dicklesworthstone scope probes (STACK_SOURCE, read through
 *   the same registry the doctor uses) appears as a first-column row in
 *   docs/setup.md; planted negative: removing a row fails naming that tool.
 * - When-absent: on a clean HOME without the tool, the doctor reports it absent
 *   (never throws); planted: a graceful-absence claim that errored would fail
 *   instead. Tern (no probe bin) is covered by its graceful send refusal.
 */
import { expect, test } from "bun:test";
import { afterAll } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspectDicklesworthstone, STACK_SOURCE } from "../../src/diagnostics.ts";
import { proveTernCliSend } from "../../src/send.ts";
import type { TernObserverIo } from "../../src/plane-tern.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });

const owned: OwnedTmp[] = [];
afterAll(() => {
	for (const t of owned) t.cleanup();
});

function freshDir(label: string): string {
	const t = ownedTmp(`setup-tools-test-${label}`, { root: scratchRoot });
	owned.push(t);
	return t.path;
}

const SETUP_MD = readFileSync(join(repoRoot, "docs/setup.md"), "utf8");

/** First-column `bin` entries of the markdown table. */
export function tableTools(markdown: string): string[] {
	const out: string[] = [];
	for (const line of markdown.split("\n")) {
		const m = /^\| `([^`]+)` \|/.exec(line.trim());
		if (m) out.push(m[1]!);
	}
	return out;
}

/** Probed bins with no table row. */
export function missingTools(markdown: string, bins: readonly string[]): string[] {
	const have = new Set(tableTools(markdown));
	return bins.filter(b => !have.has(b));
}

const PROBED = Object.keys(STACK_SOURCE).sort();

test("every probed tool has a setup-table row", () => {
	expect(missingTools(SETUP_MD, PROBED)).toEqual([]);
});

test("planted: removing one row fails naming that tool", () => {
	const withoutBr = SETUP_MD.split("\n").filter(line => !line.startsWith("| `br` |")).join("\n");
	expect(missingTools(withoutBr, PROBED)).toEqual(["br"]);
});

test("every table row fills all seven columns", () => {
	for (const line of SETUP_MD.split("\n")) {
		if (!line.startsWith("| `")) continue;
		const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim());
		expect(cells.length).toBe(7);
		for (const cell of cells) expect(cell.length).toBeGreaterThan(0);
	}
});

test("the README Installation section links the setup table", () => {
	const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
	expect(readme).toContain("docs/setup.md");
});

/** Run with a scrubbed environment; PATH/HOME are restored afterwards. */
async function withCleanHome<T>(run: () => Promise<T>): Promise<T> {
	const emptyBin = freshDir("empty-bin");
	mkdirSync(emptyBin, { recursive: true });
	const emptyHome = freshDir("empty-home");
	mkdirSync(emptyHome, { recursive: true });
	const savedPath = process.env.PATH;
	const savedHome = process.env.HOME;
	process.env.PATH = emptyBin;
	process.env.HOME = emptyHome;
	try {
		return await run();
	} finally {
		if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
		if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
	}
}

test("a clean HOME without am, br, dcg or ntm reports every tool absent, never throws", async () => {
	const finding = await withCleanHome(() => inspectDicklesworthstone());
	const tools = (finding.evidence as { tools?: { bin: string; state: string; source: string }[] } | undefined)?.tools ?? [];
	expect(tools.length).toBeGreaterThan(0);
	for (const tool of tools) {
		expect(tool.state).toBe("absent");
		expect(tool.source.length).toBeGreaterThan(0);
	}
	expect(tools.map(t => t.bin).sort()).toEqual(Object.keys(STACK_SOURCE).sort());
}, 120_000);
test("without a Tern host, a tern: send refuses gracefully with zero sends", async () => {
	const dropDir = freshDir("drop");
	mkdirSync(dropDir, { recursive: true });
	const io: TernObserverIo = {
		run: () => { throw new Error("ENOENT: tern not found"); },
		readSessionFile: () => null,
		wait: async () => {},
	};
	const result = await proveTernCliSend({
		session: "", pane: "tern:999001", message: "hello", dropDir, io,
		noBeadReason: "test-no-tern-host", env: {},
	});
	expect(result.status).toBe("REFUSED");
	expect(result.code).toBe("OBSERVATION_UNKNOWN");
	expect(result.sends).toBe(0);
}, 120_000);
