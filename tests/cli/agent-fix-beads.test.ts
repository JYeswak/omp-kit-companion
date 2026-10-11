import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// scripts/agent-fix-beads.sh routes every open `agent-fix` issue to exactly one bead (ompkit-issue-pr-autopilot-w159).
// The real script runs against stub gh and br executables whose state lives in JSON files, so a rerun observes what
// the previous run wrote, the way the cron lane does.
const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "agent-fix-beads.sh");
const REPO = "JYeswak/omp-kit-companion";
const ISSUE_URL = `https://github.com/${REPO}/issues/91`;
const root = mkdtempSync(join(tmpdir(), "omp-kit-agent-fix-beads-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface State { issues: { number: number; title: string; url: string; state: string }[]; beads: { id: string; title: string; status: string; labels: string[]; external_ref?: string; comments: string[] }[]; issueComments: { number: string; body: string }[] }

function sandbox(name: string, state: State): { dir: string; tracker: string; read: () => State } {
	const dir = join(root, name);
	const bin = join(dir, "bin");
	const tracker = join(dir, "tracker");
	mkdirSync(bin, { recursive: true });
	mkdirSync(tracker, { recursive: true });
	const statePath = join(dir, "state.json");
	writeFileSync(statePath, JSON.stringify(state));
	const header = `#!${process.execPath}\nconst fs = require("node:fs");\nconst path = ${JSON.stringify(statePath)};\nconst s = JSON.parse(fs.readFileSync(path, "utf8"));\nconst a = process.argv.slice(2);\nconst flag = name => a[a.indexOf(name) + 1];\nconst save = () => fs.writeFileSync(path, JSON.stringify(s));\n`;
	writeFileSync(join(bin, "gh"), header + [
		`if (a[0] === "issue" && a[1] === "list") console.log(JSON.stringify(s.issues.filter(i => i.state === "OPEN").map(({ number, title, url }) => ({ number, title, url }))));`,
		`else if (a[0] === "issue" && a[1] === "comment") { s.issueComments.push({ number: a[2], body: flag("--body") }); save(); }`,
		`else if (a[0] === "issue" && a[1] === "view") { const i = s.issues.find(x => x.url === a[2]); console.log(i.state === "CLOSED" ? "CLOSED COMPLETED 2026-10-11T23:00:00Z" : "OPEN  "); }`,
		`else { console.error("gh stub: unexpected " + a.join(" ")); process.exit(9); }`,
	].join("\n"));
	writeFileSync(join(bin, "br"), header + [
		`if (a[0] === "list") console.log(JSON.stringify({ issues: s.beads.filter(b => b.labels.includes("agent-fix")).map(({ comments, ...b }) => b) }));`,
		`else if (a[0] === "create") { const id = "ompkit-afx" + (s.beads.length + 1); s.beads.push({ id, title: flag("--title"), status: "open", labels: flag("-l").split(","), external_ref: flag("--external-ref"), comments: [] }); save(); console.log(id); }`,
		`else if (a[0] === "comments" && a[1] === "list") console.log(JSON.stringify(s.beads.find(b => b.id === a[2]).comments.map(text => ({ text }))));`,
		`else if (a[0] === "comments" && a[1] === "add") { s.beads.find(b => b.id === a[2]).comments.push(flag("--message")); save(); }`,
		`else { console.error("br stub: unexpected " + a.join(" ")); process.exit(9); }`,
	].join("\n"));
	chmodSync(join(bin, "gh"), 0o755);
	chmodSync(join(bin, "br"), 0o755);
	return { dir, tracker, read: () => JSON.parse(readFileSync(statePath, "utf8")) as State };
}

function route(box: { dir: string; tracker: string }): { code: number; output: string } {
	const child = Bun.spawnSync(["/bin/sh", SCRIPT, "--repo", REPO, "--tracker", box.tracker], {
		env: { PATH: `${join(box.dir, "bin")}:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin`, HOME: box.dir },
		stdout: "pipe", stderr: "pipe",
	});
	return { code: child.exitCode ?? 1, output: child.stdout.toString() + child.stderr.toString() };
}

test("N4: an open agent-fix issue becomes exactly one bead and one issue comment across reruns", () => {
	const box = sandbox("n4-idempotent", {
		issues: [{ number: 91, title: "OMP 18.9.2: memory semantics changed in src/db.ts", url: ISSUE_URL, state: "OPEN" }],
		beads: [{ id: "ompkit-other", title: "unrelated", status: "open", labels: ["fleet"], comments: [] }], issueComments: [],
	});
	const first = route(box);
	expect(first.code, first.output).toBe(0);
	expect(first.output).toContain("CREATED #91 -> ompkit-afx2");
	const second = route(box);
	expect(second.code, second.output).toBe(0);
	expect(second.output).toContain("TRACKED #91 -> ompkit-afx2");
	const state = box.read();
	const routed = state.beads.filter(bead => bead.external_ref === ISSUE_URL);
	expect(routed.map(bead => [bead.id, bead.labels.join(","), bead.title])).toEqual([["ompkit-afx2", "agent-fix,automation", "agent-fix: OMP 18.9.2: memory semantics changed in src/db.ts (#91)"]]);
	expect(state.issueComments).toHaveLength(1);
	expect(state.issueComments[0]!.body).toContain("<!-- agent-fix-bead ompkit-afx2 -->");
});

test("a bead whose issue the workflow closed gets one close note, and is never closed by the router", () => {
	const box = sandbox("closed-issue", {
		issues: [{ number: 91, title: "OMP 18.9.2: memory semantics changed", url: ISSUE_URL, state: "CLOSED" }],
		beads: [{ id: "ompkit-afx1", title: "agent-fix: OMP 18.9.2 (#91)", status: "in_progress", labels: ["agent-fix", "automation"], external_ref: ISSUE_URL, comments: [] }], issueComments: [],
	});
	expect(route(box).output).toContain(`NOTED ompkit-afx1 ${ISSUE_URL} CLOSED COMPLETED`);
	expect(route(box).output).toContain("noted=0");
	const bead = box.read().beads[0]!;
	expect(bead.status).toBe("in_progress");
	expect(bead.comments).toHaveLength(1);
	expect(bead.comments[0]).toContain("agent-fix-beads: GitHub issue closed (CLOSED COMPLETED 2026-10-11T23:00:00Z)");
});
