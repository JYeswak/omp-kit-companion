import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubFinding, hostsToken, probeGithubCapabilities, repairGithubHosts, type GhFetch, type GhFetchResponse } from "../../src/gh-doctor.ts";

function stubFetch(routes: Record<string, { status: number; scopes?: string; body: unknown }>, seen: string[]): GhFetch {
	return async (url, init) => {
		seen.push(`${init.method} ${url}`);
		const path = url.replace("https://api.github.com", "");
		const route = routes[path] ?? { status: 404, body: null };
		const headers: Record<string, string> = {};
		if (route.scopes !== undefined) headers["x-oauth-scopes"] = route.scopes;
		const res: GhFetchResponse = { status: route.status, headers, json: route.body };
		return res;
	};
}

const fullRoutes = {
	"/repos/acme/foreign": { status: 200, scopes: "repo", body: { has_issues: true } },
	"/repos/me/owned": { status: 200, scopes: "repo, workflow", body: { permissions: { push: true, admin: false } } },
	"/repos/me/owned/actions/runs?per_page=1": { status: 200, scopes: "repo", body: { total_count: 1 } },
};

describe("github capability probes", () => {
	test("every probe uses GET only; nothing mutates", async () => {
		const seen: string[] = [];
		const rows = await probeGithubCapabilities({
			foreignRepo: "acme/foreign", ownedRepo: "me/owned",
			token: "ghp_classic123", tokenSource: "test",
			fetchImpl: stubFetch(fullRoutes, seen),
		});
		expect(rows).toHaveLength(4);
		expect(seen.length).toBeGreaterThan(0);
		for (const line of seen) expect(line.startsWith("GET ")).toBe(true);
		expect(rows.every(row => row.status === "PASS")).toBe(true);
	});

	test("a token lacking workflow reports dispatch FAIL naming the scope", async () => {
		const seen: string[] = [];
		const routes = { ...fullRoutes, "/repos/me/owned": { status: 200, scopes: "repo", body: { permissions: { push: true } } } };
		const rows = await probeGithubCapabilities({
			foreignRepo: "acme/foreign", ownedRepo: "me/owned",
			token: "ghp_classic123", tokenSource: "test",
			fetchImpl: stubFetch(routes, seen),
		});
		const dispatch = rows.find(row => row.capability === "workflow_dispatch")!;
		expect(dispatch.status).toBe("FAIL");
		expect(dispatch.missing_scope).toBe("workflow");
	});

	test("the fine-grained default reports issue-create FAIL with the classic remedy", async () => {
		const seen: string[] = [];
		const rows = await probeGithubCapabilities({
			foreignRepo: "acme/foreign", ownedRepo: "me/owned",
			token: "github_pat_fine123", tokenSource: "test",
			fetchImpl: stubFetch(fullRoutes, seen),
		});
		const issue = rows.find(row => row.capability === "issue_create_foreign")!;
		expect(issue.status).toBe("FAIL");
		expect(issue.remedy).toContain("GH_ISSUES_TOKEN");
		// No foreign-repo request is made for a token that cannot use it.
		expect(seen.some(line => line.includes("acme/foreign"))).toBe(false);
	});

	test("missing token yields UNVERIFIED rows, no requests", async () => {
		const seen: string[] = [];
		const rows = await probeGithubCapabilities({
			foreignRepo: "acme/foreign", ownedRepo: "me/owned",
			home: join(tmpdir(), "gh-doctor-no-home"),
			fetchImpl: stubFetch(fullRoutes, seen),
		});
		expect(rows).toHaveLength(4);
		expect(rows.every(row => row.status === "UNVERIFIED")).toBe(true);
		expect(seen).toHaveLength(0);
	});
	test("each row names its credential without the secret", async () => {
		const seen: string[] = [];
		const rows = await probeGithubCapabilities({
			foreignRepo: "acme/foreign", ownedRepo: "me/owned",
			token: "ghp_classic123", tokenSource: "gh hosts.yml test",
			fetchImpl: stubFetch(fullRoutes, seen),
		});
 		for (const row of rows) {
 			expect(row.credential.source).toBe("gh hosts.yml test");
 			expect(row.credential.fingerprint_prefix).toBe("ghp_cla");
 			expect(JSON.stringify(row)).not.toContain("ghp_classic123");
 		}
 	});
});

describe("hosts.yml token scan", () => {
	test("reads only the github.com oauth_token", () => {
		const base = mkdtempSync(join(tmpdir(), "gh-doctor-hosts-"));
		try {
			mkdirSync(join(base, ".config", "gh"), { recursive: true });
			writeFileSync(join(base, ".config", "gh", "hosts.yml"),
				"github.com:\n    user: me\n    oauth_token: ghp_hoststoken1\n    git_protocol: https\n" +
				"ghe.example.com:\n    oauth_token: secret-other-host\n");
			const found = hostsToken(base);
			expect(found?.token).toBe("ghp_hoststoken1");
			expect(found?.source).toContain("github.com");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("absent file yields null", () => {
		expect(hostsToken(join(tmpdir(), "gh-doctor-absent"))).toBeNull();
	});
});

describe("hosts.yml repair", () => {
	test("refuses the classic token", () => {
		const base = mkdtempSync(join(tmpdir(), "gh-doctor-repair-"));
		try {
			expect(() => repairGithubHosts(base, "ghp_classic999")).toThrow("refuses the classic token");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	test("writes the fine-grained token with owner-only mode and no secret printed", () => {
		const base = mkdtempSync(join(tmpdir(), "gh-doctor-repair-"));
		try {
			mkdirSync(join(base, ".config", "gh"), { recursive: true });
			writeFileSync(join(base, ".config", "gh", "hosts.yml"), "github.com:\n    user: me\n    oauth_token: oldtoken\n");
			const result = repairGithubHosts(base, "github_pat_newfine1");
			expect(result.path).toContain("hosts.yml");
			const text = readFileSync(result.path, "utf8");
			expect(text).toContain("github_pat_newfine1");
			expect(text).not.toContain("oldtoken");
			expect(JSON.stringify(result)).not.toContain("github_pat_newfine1");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

describe("github finding fold", () => {
	test("FAIL names failing capabilities", async () => {
		const seen: string[] = [];
		const rows = await probeGithubCapabilities({
			foreignRepo: "acme/foreign", ownedRepo: "me/owned",
			token: "github_pat_fine123", tokenSource: "test",
			fetchImpl: stubFetch(fullRoutes, seen),
		});
		const finding = githubFinding(rows);
		expect(finding.component).toBe("github");
		expect(finding.status).toBe("FAIL");
		expect(finding.reason).toContain("issue_create_foreign");
	});
});
