import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { gateEventsPath } from "../extensions/gate-events.ts";
import { readJsonl } from "./kitlib/jsonl.ts";

interface Stats { samples: number; median_s: number; max_s: number }
interface RepoLatency extends Stats {
	repo: string;
	slowest_members: (Stats & { member: string })[];
}
interface Attempt { start: number; end: number }

function stats(values: number[]): Stats {
	values.sort((a, b) => a - b);
	const middle = Math.floor(values.length / 2);
	return { samples: values.length, median_s: values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2, max_s: values[values.length - 1]! };
}

/** Read-only hook span, not network/remote time. Missing historical clocks never become zero latency. */
export function inspectPushLatency(options: { env?: Record<string, string | undefined>; home?: string } = {}) {
	const ledger = gateEventsPath(options.env, options.home ?? homedir());
	const sources = [ledger + ".1", ledger];
	const issues: string[] = [];
	const repos = new Map<string, { attempts: Map<string, Attempt>; members: Map<string, number[]> }>();
	let timedRows = 0, untimedRows = 0;
	for (const path of sources) {
		try {
			const read = readJsonl(path, { maxBytes: 32 * 1024 * 1024 });
			if (read.errors.length || read.more || read.pending_tail_bytes)
				issues.push(`${path}: ${read.errors.length} invalid rows, more=${read.more}, pending_tail_bytes=${read.pending_tail_bytes}`);
			for (const raw of read.rows) {
				if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
				const row = raw as Record<string, unknown>;
				if (row.hook !== undefined && row.hook !== "pre-push") continue;
				if (row.act !== "publish" && row.act !== "push" && row.hook !== "pre-push") continue;
				const start = typeof row.started_at === "string" ? Date.parse(row.started_at) : NaN;
				if (typeof row.repo !== "string" || !isAbsolute(row.repo) || row.repo === "/" || row.repo.includes("[REDACTED]")
					|| typeof row.member !== "string" || !row.member || typeof row.attempt !== "string" || !row.attempt
					|| !Number.isFinite(start) || typeof row.duration_s !== "number" || !Number.isFinite(row.duration_s) || row.duration_s < 0
					|| !Number.isFinite(start + row.duration_s * 1000)) { untimedRows++; continue; }
				const repo = repos.get(row.repo) ?? { attempts: new Map<string, Attempt>(), members: new Map<string, number[]>() };
				repos.set(row.repo, repo);
				const end = start + row.duration_s * 1000;
				const attempt = repo.attempts.get(row.attempt);
				if (attempt) { attempt.start = Math.min(attempt.start, start); attempt.end = Math.max(attempt.end, end); }
				else repo.attempts.set(row.attempt, { start, end });
				const durations = repo.members.get(row.member) ?? [];
				durations.push(row.duration_s);
				repo.members.set(row.member, durations);
				timedRows++;
			}
		} catch (error) { issues.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
	}
	const rows: RepoLatency[] = [...repos].map(([repo, data]) => ({
		repo, ...stats([...data.attempts.values()].map(attempt => (attempt.end - attempt.start) / 1000)),
		slowest_members: [...data.members].map(([member, durations]) => ({ member, ...stats(durations) }))
			.sort((a, b) => b.max_s - a.max_s || a.member.localeCompare(b.member)).slice(0, 5),
	})).sort((a, b) => b.max_s - a.max_s || a.repo.localeCompare(b.repo));
	const overall = issues.length ? "PARTIAL" : rows.length ? "OK" : "UNVERIFIED";
	const text = ["Push latency: observed pre-push hook span (first member start to last member end; excludes transport and trailing recorder work).",
		...rows.flatMap(row => [`${row.repo}: n=${row.samples} median=${row.median_s.toFixed(3)}s max=${row.max_s.toFixed(3)}s`,
			...row.slowest_members.map(member => `  ${member.member}: n=${member.samples} median=${member.median_s.toFixed(3)}s max=${member.max_s.toFixed(3)}s`)]),
		...(!rows.length ? ["No attributable timed push attempts recorded."] : []),
		`Timed member rows=${timedRows}; excluded incomplete/legacy push rows=${untimedRows}; status=${overall}.`, ...issues].join("\n");
	return { scope: "push-latency" as const, overall, sources, repos: rows, timed_rows: timedRows, untimed_rows: untimedRows, issues, text };
}
