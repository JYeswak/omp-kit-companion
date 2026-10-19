// ompkit-5vph "Every rch repo": doctor --scope mission lists each repo that builds through rch and whether its gate
// calls the kit lease; a repo-local lease script (planted copy of the old uds one) is a finding naming the file.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { censusMissionRch, inspectMissionRch, type MissionRchIo } from "../../src/mission-rch.ts";

const scratch = mkdtempSync(join(tmpdir(), "doctor-mission-"));
const repoRoot = resolve(import.meta.dir, "../..");
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

function mem(repos: { repo: string; source: string }[], files: Record<string, string>): MissionRchIo {
	return {
		repos: () => repos,
		listDir: (path) => {
			const dir = path.endsWith("/") ? path.slice(0, -1) : path;
			if (files[`${dir}/`] !== undefined) return files[`${dir}/`]!.split(",").filter(Boolean);
			const names = new Set<string>();
			const sub = new Set<string>();
			for (const file of Object.keys(files)) {
				if (!file.startsWith(`${dir}/`)) continue;
				const rest = file.slice(dir.length + 1);
				if (rest.includes("/")) sub.add(rest.split("/")[0]!);
				else names.add(rest);
			}
			const all = [...names, ...sub];
			return files[`${dir}/`] !== undefined || all.length > 0 ? all : null;
		},
		readText: (path) => files[path] ?? null,
		isDir: (path) => files[`${path}/`] !== undefined || Object.keys(files).some((file) => file.startsWith(`${path}/`)),
	};
}
const leaseSh = "#!/bin/sh\n# the old uds lease: pre, post, LEASE line\nrch exec \"$@\"\nrefuse rch_capacity_unavailable\n";

test("a repo gatting through the kit lease is OK; a direct rch caller without it is a finding; nothing calling rch is not a repo", () => {
	const io = mem([{ repo: "/a", source: "t:a" }, { repo: "/b", source: "t:b" }, { repo: "/c", source: "t:c" }],
		{ "/a/": "", "/b/": "", "/c/": "",
			"/a/Makefile": "build:\n\tomp-kit rch lease --slots 1 -- cargo check\n", "/b/scripts/build.sh": "rch exec cargo check\n",
			"/c/Makefile": "build:\n\tcargo build\n" });
	const rows = censusMissionRch(io);
	expect(rows.map((row) => [row.repo, row.state])).toEqual([["/a", "KIT_LEASE"], ["/b", "NO_KIT_LEASE"], ["/c", "NOT_RCH"]]);
	expect(rows[0]).toMatchObject({ kit_lease_in: ["Makefile"], files_scanned: 1 });
	const findings = inspectMissionRch(io);
	expect(findings.map((row) => [row.component, row.status])).toEqual([["mission_rch", "DEGRADED"], ["mission_rch:a", "OK"], ["mission_rch:b", "DEGRADED"]]);
	expect(findings[0]!.reason).toContain("3 repo(s), 2 build through rch, 1 of those gate on omp-kit rch lease");
});

test("planted: a copy of the old uds lease script is a finding naming the file even when the kit lease is present elsewhere", () => {
	const io = mem([{ repo: "/d", source: "t:d" }], { "/d/": "", "/d/scripts/rch-lease.sh": leaseSh, "/d/justfile": "x:\n\tomp-kit rch lease --slots 1 -- cargo check\n" });
	const rows = censusMissionRch(io);
	expect(rows).toMatchObject([{ repo: "/d", state: "LOCAL_LEASE_SCRIPT", local_lease: ["scripts/rch-lease.sh"], kit_lease_in: ["justfile"] }]);
	const findings = inspectMissionRch(io);
	expect(findings[0]!.status).toBe("DEGRADED");
	expect(findings[0]!.reason).toContain("local lease script scripts/rch-lease.sh");
	expect(findings[1]).toMatchObject({ component: "mission_rch:d", status: "DEGRADED" });
});

test("a doc mentioning the refusal token is not a lease script; a script with the token is", () => {
	const io = mem([{ repo: "/e", source: "t:e" }], { "/e/": "",
		"/e/docs/NOTES.md": "refusals use rch_capacity_unavailable, and run rch exec cargo check\n",
		"/e/scripts/lease": "#!/bin/sh\nrch exec \"$@\"\nrefuse rch_capacity_unavailable\n" });
	const rows = censusMissionRch(io);
	expect(rows).toMatchObject([{ repo: "/e", state: "LOCAL_LEASE_SCRIPT", local_lease: ["scripts/lease"] }]);
	const docsOnly = mem([{ repo: "/f", source: "t:f" }], { "/f/": "", "/f/docs/NOTES.md": "refusals use rch_capacity_unavailable\n" });
	expect(censusMissionRch(docsOnly)).toMatchObject([{ repo: "/f", state: "NOT_RCH" }]);
});

test("the same repo listed twice is counted once", () => {
	const io = mem([{ repo: "/a", source: "t:1" }, { repo: "/a", source: "t:2" }], { "/a/": "", "/a/Makefile": "build:\n\tomp-kit rch lease --slots 1 -- cargo check\n" });
	expect(censusMissionRch(io).map((row) => row.repo)).toEqual(["/a"]);
});

test("doctor --scope mission through the CLI accepts the scope and reports the planted repo", () => {
	const base = mkdtempSync(join(tmpdir(), "mission-cli-"));
	try {
		const home = join(base, "home");
		const repo = join(base, "repo");
		mkdirSync(join(home, ".config", "omp-kit"), { recursive: true });
		mkdirSync(join(repo, "scripts"), { recursive: true });
		writeFileSync(join(home, ".config", "omp-kit", "fleet-watch.json"), JSON.stringify({ sessions: [{ session: "probe", repo }] }));
		writeFileSync(join(repo, "scripts", "build.sh"), "rch exec cargo build\n");
		const env = { ...process.env, HOME: home, OMP_KIT_OMP_SRC_FETCH: "0" } as Record<string, string>;
		const child = Bun.spawnSync([process.execPath, "run", join(repoRoot, "src", "cli.ts"), "doctor", "--scope", "mission", "--json"],
			{ env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		expect(child.exitCode).toBe(0);
		const body = JSON.parse(child.stdout.toString()) as { data: { findings: { component: string; status: string }[] } };
		expect(body.data.findings.map((row) => row.component)).toEqual(["mission_rch", "mission_rch:repo"]);
		expect(body.data.findings[0]!.status).toBe("DEGRADED");
	} finally { rmSync(base, { recursive: true, force: true }); }
}, 120_000);

test("a repo dir that cannot be read is UNREADABLE, never a finding; no repos is UNVERIFIED", () => {
	const io = mem([{ repo: "/gone", source: "t:x" }], {});
	expect(censusMissionRch(io)).toMatchObject([{ repo: "/gone", state: "UNREADABLE" }]);
	expect(inspectMissionRch(io)[0]).toMatchObject({ component: "mission_rch", status: "UNVERIFIED" });
	expect(inspectMissionRch(mem([], {}))[0]).toMatchObject({ component: "mission_rch", status: "UNVERIFIED" });
});

// diagnose() itself stays mission-free (like ownership): the mission rows come from the CLI's scope branch,
// which the CLI test above exercises end to end through the real CLI with a fixture HOME.
