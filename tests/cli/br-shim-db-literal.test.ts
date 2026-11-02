import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

// DBLITERAL1 (ompkit-nxlx1 AC1): a tracker path holding an unexpanded `$NAME` is refused before br runs.
// The fake br records every invocation and, like the real one, creates the database file it is pointed at.
const root = resolve(import.meta.dir, "../..");
const shimSource = readFileSync(join(root, "scripts/br-shim.sh"), "utf8");
const CHECK = /# DBLITERAL1 \(ompkit-nxlx1\)[\s\S]*?\ndone\n/;

function fixture(source = shimSource) {
	const scratch = ownedTmp("br-shim-db-literal");
	const repo = join(scratch.path, "repo");
	mkdirSync(join(repo, ".beads"), { recursive: true });
	const calls = join(scratch.path, "calls.log");
	const fakeBr = join(scratch.path, "br-real");
	writeFileSync(fakeBr, `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
prev=""
for a in "$@"; do
	if [ "$prev" = "--db" ]; then : > "$a"; fi
	prev="$a"
done
exit 0
`, { mode: 0o755 });
	const shim = join(scratch.path, "br-shim.sh");
	writeFileSync(shim, source, { mode: 0o755 });
	const call = async (args: string[], env: Record<string, string> = {}) => {
		const { BEADS_DB: _drop, ...base } = process.env;
		const r = await run(["sh", shim, ...args], {
			deadline_s: 30, cwd: repo, max_output_bytes: 256 * 1024,
			env: { ...base, AGENT_NAME: "Verifier", BR_REAL: fakeBr, TMPDIR: scratch.path, ...env },
		});
		return { rc: r.rc, output: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
	};
	const ran = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
	return { scratch, repo, call, ran };
}

test("DBLITERAL1 a literal $DB --db is refused before br runs and creates no file", async () => {
	const f = fixture();
	try {
		for (const args of [["--db", "$DB", "list"], ["--db=$DB", "list"], ["list", "--db", "${DB}/beads.db"]]) {
			const r = await f.call(args);
			expect(r.rc, r.output).toBe(4);
			expect(r.output).toContain("BR_SHIM_DB_LITERAL");
		}
		const env = await f.call(["list"], { BEADS_DB: "$DB" });
		expect(env.rc, env.output).toBe(4);
		expect(env.output).toContain("BR_SHIM_DB_LITERAL");
		expect(f.ran()).toBe("");
		expect(existsSync(join(f.repo, "$DB"))).toBe(false);
	} finally {
		f.scratch.cleanup();
	}
});

test("DBLITERAL1 control: an ordinary tracker path still reaches br", async () => {
	const f = fixture();
	try {
		const r = await f.call(["--db", ".beads/beads.db", "list"]);
		expect(r.rc, r.output).toBe(0);
		expect(f.ran()).toContain("--db .beads/beads.db list");
	} finally {
		f.scratch.cleanup();
	}
});

test("DBLITERAL1 planted negative: without the check the same call creates the $DB database", async () => {
	expect(CHECK.test(shimSource)).toBe(true);
	const f = fixture(shimSource.replace(CHECK, ""));
	try {
		const r = await f.call(["--db", "$DB", "list"]);
		expect(r.output).not.toContain("BR_SHIM_DB_LITERAL");
		expect(f.ran()).toContain("--db $DB list");
		expect(existsSync(join(f.repo, "$DB"))).toBe(true);
	} finally {
		f.scratch.cleanup();
	}
});
