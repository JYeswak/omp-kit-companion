import { expect, test } from "bun:test";
import { inspectOmpSessions, parsePsProcesses, parseTmuxPanes, type SessionInstall, type SessionProcess } from "../../src/session-doctor.ts";

const components = (agents: number): SessionInstall[] => [
	{ label: "OMP package", path: "/omp/package", version: "18.5.0", installed_at_epoch_ms: 1000 },
	{ label: "kit plugin", path: "/kit/plugin", version: "0.2.3", installed_at_epoch_ms: 2000 },
	{ label: "~/.agents/AGENTS.md", path: "/home/josh/.agents/AGENTS.md", version: null, installed_at_epoch_ms: agents },
];

const process = (start: number): SessionProcess => ({
	pid: 42,
	ppid: 1,
	command: "bun /Users/josh/.bun/bin/omp --profile claude",
	start_epoch_ms: start,
	start_text: "Sat Oct 3 10:00:00 2026",
});

test("session inventory parses OMP processes and tmux panes", () => {
	const ps = " 42 1 Sat Oct  3 10:00:00 2026 bun /Users/josh/.bun/bin/omp --profile claude\n 43 1 Sat Oct  3 10:00:01 2026 /bin/zsh -l";
	const tmux = "omp-test 0.1\t42\tomp --profile claude\n";
	expect(parsePsProcesses(ps)).toHaveLength(1);
	expect(parsePsProcesses(ps)[0]?.pid).toBe(42);
	expect(parseTmuxPanes(tmux)).toEqual([{ pane: "omp-test 0.1", pid: 42, start_command: "omp --profile claude" }]);
});

test("session started after all install markers is CURRENT and names its pane", () => {
	const report = inspectOmpSessions({ processes: [process(3000)], panes: [{ pane: "omp-test 0.1", pid: 42, start_command: "omp --profile claude" }], components: components(2500), now_epoch_ms: 4000 });
	const session = report.sessions[0]!;
	expect(session.verdict).toBe("CURRENT");
	expect(session.pane).toBe("omp-test 0.1");
	expect(session.predates).toEqual([]);
	expect(report.text).toContain("kit plugin 0.2.3");
});

test("touching AGENTS.md flips a current session to STALE with the marker named", () => {
	const report = inspectOmpSessions({ processes: [process(3000)], panes: [], components: components(3500), now_epoch_ms: 4000 });
	const session = report.sessions[0]!;
	expect(session.verdict).toBe("STALE");
	expect(session.predates).toEqual(["~/.agents/AGENTS.md"]);
	expect(report.text).toContain("predates ~/.agents/AGENTS.md");
});

test("missing install evidence is UNVERIFIED instead of falsely CURRENT", () => {
	const report = inspectOmpSessions({ processes: [process(3000)], panes: [], components: [{ ...components(2500)[0]!, installed_at_epoch_ms: null }, ...components(2500).slice(1)], now_epoch_ms: 4000 });
	expect(report.sessions[0]?.verdict).toBe("UNVERIFIED");
	expect(report.sessions[0]?.reason).toContain("OMP package");
});
