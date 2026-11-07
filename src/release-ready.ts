// RELREADY1: read-only release qualification inventory. Never runs a suite or opens a keychain.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "./kitlib/tmp.ts";
import { runSync } from "./kitlib/run.ts";
import { checkReadme } from "../scripts/readme-check.ts";
import type { Finding } from "./diagnostics.ts";

export interface ReleaseReadyCheck { name: string; ok: boolean; detail: string }
export interface ReleaseReadyReport {
	status: "READY" | "NOT-READY";
	commit: string | null;
	version: string | null;
	checks: ReleaseReadyCheck[];
	line: string;
}

export function inspectReleaseReady(repo: string, kitRoot: string): ReleaseReadyReport {
	const checks: ReleaseReadyCheck[] = [];
	let commit: string | null = null, version: string | null = null;
	const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => item[1] !== undefined));
	for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_TERMINAL_PROMPT") delete env[key];
	const decoder = new TextDecoder();
	const probe = (name: string, argv: string[]) => {
		const result = runSync(argv, { cwd: repo, env, deadline_s: 60, max_output_bytes: 1 << 20 });
		const stdout = decoder.decode(result.stdout).trim();
		const ok = result.rc === 0 && !result.timed_out && !result.truncated && !result.total_truncated && !result.killed;
		const detail = ok ? "PASS" : [stdout, decoder.decode(result.stderr).trim(), result.timed_out ? "TIMEOUT" : "", result.truncated || result.total_truncated ? "OUTPUT_TRUNCATED" : ""].filter(Boolean).join(" ") || `exit ${result.rc}`;
		checks.push({ name, ok, detail });
		return { ok, stdout };
	};
	try {
		const remote = probe("remote-main", ["git", "ls-remote", "--exit-code", "origin", "refs/heads/main"]);
		const source = remote.ok ? probe("origin-main", ["git", "rev-parse", "--verify", `${remote.stdout.split("\t")[0]}^{commit}`]) : null;
		if (source?.ok) {
			commit = source.stdout;
			const temp = ownedTmp("release-ready");
			try {
				const exported = probe("source-export", ["bash", "-o", "pipefail", "-c", 'git -C "$1" archive "$2" | tar -xf - -C "$3"', "release-ready", repo, commit, temp.path]);
				if (exported.ok) {
					const pkg = JSON.parse(readFileSync(join(temp.path, "package.json"), "utf8"));
					if (typeof pkg.version !== "string") throw new Error("package.json has no version");
					version = pkg.version;
					const library = join(kitRoot, "scripts/release-preflight.sh");
					const tags = probe("remote-tags", ["git", "ls-remote", "--tags", "origin"]);
					if (tags.ok) {
						const next = probe("next-version", ["sh", library, "next_version", version, tags.stdout]);
						if (next.ok) version = next.stdout;
					}
					for (const [name, fn] of [["version", "version"], ["ship-signing", "signing"], ["ship-attestation", "attestation"]]) {
						probe(name!, ["sh", library, fn!, repo, commit, version, temp.path]);
					}
					if (tags.ok) {
						const names = new Set(tags.stdout.split("\n").map(line => line.split("\t")[1]));
						checks.push({ name: "unused-version", ok: !names.has(`refs/tags/v${version}`), detail: names.has(`refs/tags/v${version}`) ? `tag v${version} already exists; advance main before cutting` : `v${version} is untagged` });
						const findings = checkReadme(readFileSync(join(temp.path, "README.md"), "utf8"), {
							registry: null, inventory: { rules: null, extensions: null, skills: null }, release: true, sections: false,
						}, pkg.version, tag => names.has(`refs/tags/v${tag}`) ? "present" : "absent");
						checks.push({ name: "readme-version", ok: findings.length === 0, detail: findings.join("; ") || "PASS" });
					}
					const releases = probe("release-list", ["bash", "-o", "pipefail", "-c", 'gh api --paginate --slurp "$1" | jq -c \'[[.[][] | {tag_name,draft,prerelease}]]\'', "release-ready", `repos/${process.env.OMP_KIT_REPO ?? "JYeswak/omp-kit-companion"}/releases?per_page=100`]);
					if (releases.ok) {
						const path = join(temp.path, "readiness-releases.json");
						writeFileSync(path, releases.stdout);
						probe("release-availability", ["sh", library, "releases", version, path]);
					}
					const dirty = probe("metadata-clean", ["git", "status", "--porcelain", "--untracked-files=all", "--", "package.json", "README.md"]);
					if (dirty.ok && dirty.stdout) checks[checks.length - 1] = { name: "metadata-clean", ok: false, detail: dirty.stdout };
					const tree = probe("source-tree", ["git", "rev-parse", `${commit}^{tree}`]);
					if (tree.ok) for (const role of ["main", "ci-only"]) {
						const verdict = probe(`${role}-verdict`, ["sh", library, "verdict", role, repo, tree.stdout, temp.path]);
						if (verdict.ok && verdict.stdout !== "PASS") checks[checks.length - 1] = { name: `${role}-verdict`, ok: false, detail: verdict.stdout || "empty verdict readback" };
					}
					probe("ship-export", ["sh", library, "export", temp.path, commit]);
				}
			} finally { temp.cleanup(); }
		}
	} catch (error) {
		checks.push({ name: "readiness-input", ok: false, detail: error instanceof Error ? error.message : String(error) });
	}
	const failures = checks.filter(check => !check.ok);
	const status = failures.length ? "NOT-READY" : "READY";
	const line = `${status} origin/main=${commit ?? "unknown"} version=${version ?? "unknown"}${failures.length ? "; " + failures.map(check => `${check.name}: ${check.detail.split("\n").join(" ").split("\r").join(" ")}`).join("; ") : ""}`;
	return { status, commit, version, checks, line };
}

export function releaseReadyFinding(repo: string, kitRoot: string): Finding {
	const report = inspectReleaseReady(repo, kitRoot);
	return { component: "release", status: report.status === "READY" ? "OK" : "FAIL", reason: report.line,
		recommended_action: report.status === "READY" ? "Cut with scripts/release-local.sh." : "Fix each named preflight; produce missing verdicts with scripts/release-verdict.sh.", evidence: { ...report } };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const at = args.indexOf("--repo");
	const report = inspectReleaseReady(at >= 0 ? resolve(args[at + 1]!) : process.cwd(), resolve(import.meta.dir, ".."));
	console.log(args.includes("--json") ? JSON.stringify(report) : report.line);
	process.exitCode = report.status === "READY" ? 0 : 1;
}
