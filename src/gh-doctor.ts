/** gh-doctor.ts — GH1 (ompkit-jfe3): read-only GitHub capability probes.
 *
 * doctor --scope github prints one row per capability. Every row is
 * {capability, credential:{source, fingerprint_prefix, kind}, status, missing_scope?, remedy?}.
 * Probes never mutate: only REST GET requests (a planted test asserts no
 * POST/PUT/PATCH/DELETE is ever made) plus local file reads. Live network is
 * used at most once per operator run; tests inject a stub fetch.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Finding } from "./diagnostics.ts";

export type GhCapabilityStatus = "PASS" | "FAIL" | "UNVERIFIED";

export interface GhCredential {
	/** Where the token came from; never the token itself. */
	source: string;
	/** First 7 chars (e.g. "ghp_abc"); enough to match `gh auth status`, not enough to use. */
	fingerprint_prefix: string;
	kind: "classic" | "fine-grained" | "unknown";
}

export interface GhCapabilityRow {
	capability: "issue_create_foreign" | "push_owned" | "workflow_dispatch" | "run_read";
	credential: GhCredential;
	status: GhCapabilityStatus;
	missing_scope?: string;
	remedy?: string;
}

export interface GhFetchResponse {
	status: number;
	headers: Record<string, string>;
	json: unknown;
}

export type GhFetch = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<GhFetchResponse>;

export interface GhProbeInput {
	/** Foreign repo used for the issue-create probe. */
	foreignRepo: string;
	/** Owned repo used for push/dispatch/runs probes. */
	ownedRepo: string;
	/** Token; when omitted the hosts.yml default is read (no network). */
	token?: string;
	/** Token source label; derived from origin when omitted. */
	tokenSource?: string;
	fetchImpl?: GhFetch;
	/** HOME override for hosts.yml lookup (tests). */
	home?: string;
}

const API = "https://api.github.com";

/** Token kind drives probe branching and the repair refusal; both must agree. */
export function kindOf(token: string): GhCredential["kind"] {
	if (token.startsWith("ghp_") || token.startsWith("gho_")) return "classic";
	if (token.startsWith("github_pat_")) return "fine-grained";
	return "unknown";
}
/** Synchronous hosts.yml scan: github.com oauth_token only, no other host is read. */
export function hostsToken(home: string): { token: string; source: string } | null {
	let text: string;
	try {
		text = readFileSync(`${home}/.config/gh/hosts.yml`, "utf8");
	} catch {
		return null;
	}
	const lines = text.split("\n");
	let inGithub = false;
	for (const line of lines) {
		if (/^\s*github\.com\s*:\s*$/.test(line)) {
			inGithub = true;
			continue;
		}
		if (/^\S/.test(line)) inGithub = false;
		if (inGithub) {
			const match = /^\s*oauth_token\s*:\s*(\S+)\s*$/.exec(line);
			if (match) return { token: match[1]!, source: "gh hosts.yml github.com oauth_token" };
		}
	}
	return null;
}

async function getJson(fetchImpl: GhFetch, token: string, path: string): Promise<{ status: number; scopes: string[]; body: unknown }> {
	const res = await fetchImpl(`${API}${path}`, {
		method: "GET",
		headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
	});
	const raw = res.headers["x-oauth-scopes"] ?? res.headers["X-OAuth-Scopes"] ?? "";
	const scopes = raw.split(",").map(part => part.trim()).filter(Boolean);
	return { status: res.status, scopes, body: res.json };
}

function permsOf(body: unknown): { push: boolean; admin: boolean } {
	if (!body || typeof body !== "object" || !("permissions" in body)) return { push: false, admin: false };
	const perms = body.permissions;
	if (!perms || typeof perms !== "object") return { push: false, admin: false };
	const push = "push" in perms && perms.push === true;
	const admin = "admin" in perms && perms.admin === true;
	return { push: push || admin, admin };
}

export async function probeGithubCapabilities(input: GhProbeInput): Promise<GhCapabilityRow[]> {
	const home = input.home ?? process.env.HOME ?? "";
	const found = input.token !== undefined
		? { token: input.token, source: input.tokenSource ?? "caller-supplied token" }
		: hostsToken(home);
	if (!found || !found.token) {
		const credential: GhCredential = { source: "none found", fingerprint_prefix: "", kind: "unknown" };
		const unverified = (capability: GhCapabilityRow["capability"]): GhCapabilityRow =>
			({ capability, credential, status: "UNVERIFIED", remedy: "Authenticate gh (gh auth login) then rerun omp-kit doctor --scope github." });
		return [unverified("issue_create_foreign"), unverified("push_owned"), unverified("workflow_dispatch"), unverified("run_read")];
	}
	const credential: GhCredential = { source: found.source, fingerprint_prefix: found.token.slice(0, 7), kind: kindOf(found.token) };
	const fetchImpl = input.fetchImpl ?? (async (url, init) => {
		const res = await fetch(url, init);
		const headers: Record<string, string> = {};
		res.headers.forEach((value, key) => { headers[key] = value; });
		return { status: res.status, headers, json: await res.json().catch(() => null) };
	});
	const rows: GhCapabilityRow[] = [];

	// issue_create_foreign: a fine-grained token is repo-scoped and cannot file
	// on foreign repos; the classic token (public_repo) can.
	if (credential.kind === "fine-grained") {
		rows.push({ capability: "issue_create_foreign", credential, status: "FAIL", missing_scope: "repo-wide issue create", remedy: "File foreign-repo issues with the classic GH_ISSUES_TOKEN (public_repo), injected per call, never written to hosts.yml." });
	} else {
		const repo = await getJson(fetchImpl, found.token, `/repos/${input.foreignRepo}`);
		const body = repo.body;
		const open = !!body && typeof body === "object" && "has_issues" in body && body.has_issues === true;
		rows.push(repo.status === 200 && open
			? { capability: "issue_create_foreign", credential, status: "PASS" }
			: { capability: "issue_create_foreign", credential, status: "FAIL", missing_scope: "issue create", remedy: "Use the classic GH_ISSUES_TOKEN (public_repo) for foreign-repo issues." });
	}

	const owned = await getJson(fetchImpl, found.token, `/repos/${input.ownedRepo}`);
	const perms = owned.status === 200 ? permsOf(owned.body) : { push: false, admin: false };
	rows.push(owned.status === 200 && perms.push
		? { capability: "push_owned", credential, status: "PASS" }
		: { capability: "push_owned", credential, status: "FAIL", missing_scope: "push", remedy: "Grant Contents write on the owned repo, then rerun." });

	if (owned.scopes.length > 0) {
		rows.push(owned.scopes.includes("workflow")
			? { capability: "workflow_dispatch", credential, status: "PASS" }
			: { capability: "workflow_dispatch", credential, status: "FAIL", missing_scope: "workflow", remedy: "Grant the workflow scope (classic) or Actions write (fine-grained), then rerun." });
	} else {
		rows.push({ capability: "workflow_dispatch", credential, status: "UNVERIFIED", remedy: "Fine-grained tokens omit oauth scopes; grant Actions write or verify dispatch with a classic token carrying the workflow scope." });
	}

	const runs = await getJson(fetchImpl, found.token, `/repos/${input.ownedRepo}/actions/runs?per_page=1`);
	rows.push(runs.status === 200
		? { capability: "run_read", credential, status: "PASS" }
		: { capability: "run_read", credential, status: "FAIL", missing_scope: "actions read", remedy: "Grant Actions read (fine-grained) or repo scope (classic), then rerun." });

	return rows;
}

export function githubFinding(rows: GhCapabilityRow[]): Finding {
	const failed = rows.filter(row => row.status === "FAIL");
	const unverified = rows.filter(row => row.status === "UNVERIFIED");
	return {
		component: "github",
		status: failed.length ? "FAIL" : unverified.length ? "UNVERIFIED" : "OK",
		reason: failed.length
			? `${failed.length} GitHub capabilit${failed.length === 1 ? "y" : "ies"} failing: ${failed.map(row => row.capability).join(", ")}`
			: unverified.length ? `${unverified.length} GitHub capabilities unverified` : "All GitHub capability probes pass",
		recommended_action: failed.length
			? (failed[0]!.remedy ?? "Rerun omp-kit doctor --scope github.")
			: "No action required.",
		evidence: { capabilities: rows },
	};
}

/** Repair: rewrite hosts.yml github.com oauth_token from an Infisical-supplied
 * fine-grained token. Refuses classic tokens and prints no secret. */
export function repairGithubHosts(home: string, token: string): { path: string; user: string } {
	const kind = kindOf(token);
	if (kind === "classic") throw new Error("repair refuses the classic token: supply the Infisical fine-grained token.");
	if (!token || /\s/.test(token)) throw new Error("repair needs a non-empty Infisical fine-grained token.");
	const path = `${home}/.config/gh/hosts.yml`;
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch {
		text = "";
	}
	const userMatch = /^\s*user\s*:\s*(\S+)\s*$/m.exec(text);
	const user = userMatch ? userMatch[1]! : "";
	const block = `github.com:\n    user: ${user}\n    oauth_token: ${token}\n    git_protocol: https\n`;
	const replaced = text.replace(/^github\.com:\n(?:[ \t]+.*\n?)*/m, block);
	const next = text === replaced && !/^github\.com:/m.test(text) ? `${text.replace(/\s*$/, "\n")}${block}` : replaced;
	mkdirSync(`${home}/.config/gh`, { recursive: true, mode: 0o700 });
	writeFileSync(path, next, { mode: 0o600 });
	return { path, user };
}
