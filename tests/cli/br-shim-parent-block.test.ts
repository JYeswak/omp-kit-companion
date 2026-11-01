import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

// PARENTBLOCK1 (ompkit-rc-epic-land-fix-release-dogfood-rz5.134): the actual br shim refuses a blocks edge from a bead
// onto one of its own parent-child descendants, which parent-blocks every child and drops them from br ready.
// Measured on 2026-11-01: four such edges onto release-train epic ompkit-774u hid 51-54 of ~60 children.
const root = resolve(import.meta.dir, "../..");
const decoder = new TextDecoder();
const CASE_BUDGET_MS = 60_000;

// P is the parent; C and S are its children; G is C's child; U is unrelated.
const ROWS = [
	{ id: "pb-P", parent: null },
	{ id: "pb-C", parent: "pb-P" },
	{ id: "pb-S", parent: "pb-P" },
	{ id: "pb-G", parent: "pb-C" },
	{ id: "pb-U", parent: null },
].map(({ id, parent }) => ({
	id, title: id, status: "open",
	dependencies: parent ? [{ id: parent, dependency_type: "parent-child", status: "open" }] : [],
}));

async function depAdd(args: string[]): Promise<{ rc: number; output: string; added: string[] }> {
	const scratch = ownedTmp("parent-block-shim-test");
	try {
		const home = join(scratch.path, "home");
		const release = join(scratch.path, "release");
		const bin = join(scratch.path, "bin");
		const project = join(scratch.path, "tracker");
		for (const path of [home, join(release, "scripts"), bin, join(project, ".beads")]) mkdirSync(path, { recursive: true });
		for (const file of ["br-shim.sh", "br-update-lint.py", "kitlib_run.py", "kitlib_tmp.py", "pysafe.py"]) copyFileSync(join(root, "scripts", file), join(release, "scripts", file));
		for (const utility of ["dirname", "basename", "python3"]) {
			const executable = Bun.which(utility);
			if (!executable) throw new Error(`PARENTBLOCK1 fixture requires ${utility}`);
			symlinkSync(executable, join(bin, utility));
		}
		const data = join(scratch.path, "beads.json");
		writeFileSync(data, JSON.stringify(ROWS));
		const added = join(scratch.path, "added.jsonl");
		const realBr = join(bin, "br-real");
		// The tracker fixture serves `show` from rows and records every edge it would add.
		writeFileSync(realBr, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const raw = process.argv.slice(2);
const args = raw.filter((a, i) => a !== "--json" && !["--db", "--actor"].includes(a) && !["--db", "--actor"].includes(raw[i - 1]));
const rows = JSON.parse(readFileSync(process.env.PB_DATA, "utf8"));
if (args[0] === "show") {
  const bead = rows.find(row => row.id === args[1]);
  if (!bead) process.exit(3);
  console.log(JSON.stringify([bead]));
} else if (args[0] === "dep" && args[1] === "add") {
  appendFileSync(process.env.PB_ADDED, JSON.stringify(args) + "\\n");
} else {
  console.error("unexpected tracker command " + JSON.stringify(args));
  process.exit(8);
}
`, { mode: 0o755 });
		writeFileSync(join(bin, "am"), `#!/bin/sh
case "$1:$2" in
  agents:show) printf '{"name":"ParentBlockFixture"}\\n' ;;
  file_reservations:conflicts) printf 'No conflicts detected.\\n' ;;
  *) exit 9 ;;
esac
`, { mode: 0o755 });
		const result = await run(["/bin/sh", join(release, "scripts/br-shim.sh"), "--db", join(project, ".beads/beads.db"), ...args], {
			cwd: project, deadline_s: 30,
			env: { HOME: home, PATH: bin, AGENT_NAME: "ParentBlockFixture", BR_REAL: realBr,
				XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local/state"),
				PB_DATA: data, PB_ADDED: added, TMPDIR: scratch.path },
		});
		return { rc: result.rc ?? -1, output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
			added: existsSync(added) ? readFileSync(added, "utf8").trim().split("\n").filter(Boolean) : [] };
	} finally {
		scratch.cleanup();
	}
}

test("PARENTBLOCK1 planted: a parent blocked by its own child or grandchild is refused and no edge is written", async () => {
	for (const child of ["pb-C", "pb-G"]) {
		const out = await depAdd(["dep", "add", "pb-P", child]);
		expect(out.rc, out.output).toBe(4);
		expect(out.output).toContain("PARENT_CHILD_BLOCKS");
		expect(out.output).toContain("rz5.134");
		expect(out.added).toEqual([]);
	}
	const explicit = await depAdd(["dep", "add", "pb-P", "pb-C", "--type", "blocks"]);
	expect(explicit.rc, explicit.output).toBe(4);
	expect(explicit.added).toEqual([]);
}, CASE_BUDGET_MS);

test("PARENTBLOCK1 controls: related type, child-to-sibling and unrelated blocks edges still pass through", async () => {
	for (const args of [
		["dep", "add", "pb-P", "pb-C", "--type", "related"],
		["dep", "add", "pb-C", "pb-S"],
		["dep", "add", "pb-U", "pb-C"],
		["dep", "add", "pb-C", "pb-P"],
	]) {
		const out = await depAdd(args);
		expect(out.rc, `${args.join(" ")}: ${out.output}`).toBe(0);
		expect(out.output).not.toContain("PARENT_CHILD_BLOCKS");
		expect(out.added).toHaveLength(1);
	}
}, CASE_BUDGET_MS);
