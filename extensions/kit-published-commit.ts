export type PublishedCommitStatus = "PUBLISHED" | "NOT_PUBLISHED" | "UNKNOWN";
export interface PublishedCommitCheck {
	status: PublishedCommitStatus;
	sha: string;
	detail: string;
}
export type PublicationGit = (repo: string, args: string[]) => Promise<{ rc: number | null; out: string; failed: boolean }>;

/** Extract the transition's commit citations using the close-guard grammar. */
export function extractCitedCommitShas(value: string): string[] {
	if (value.length > 1024 * 1024) return [];
	const patterns = [
		/\bDONE[ \t]+\S+[ \t]+([0-9a-f]{7,40})(?![0-9a-f])/gi,
		/@([0-9a-f]{7,40})(?![0-9a-f])/gi,
		/\bexport[ \t]+([0-9a-f]{7,40})(?![0-9a-f])/gi,
		/\bcommit[ \t]+([0-9a-f]{7,40})(?![0-9a-f])/gi,
	];
	const found = new Set<string>();
	for (const pattern of patterns) {
		for (const match of value.matchAll(pattern)) found.add(match[1]!.toLowerCase());
	}
	return [...found];
}

/** Verify each cited commit against a newly fetched origin/main; all errors fail closed as UNKNOWN. */
export async function checkPublishedCommits(
	repo: string,
	shas: readonly string[],
	execute: PublicationGit,
): Promise<PublishedCommitCheck[]> {
	if (shas.length === 0) return [{ status: "UNKNOWN", sha: "", detail: "no cited commit SHA" }];
	const unique = [...new Set(shas.map(sha => sha.toLowerCase()))];
	const valid = unique.filter(sha => /^[0-9a-f]{7,40}$/.test(sha));
	const invalid = unique.filter(sha => !/^[0-9a-f]{7,40}$/.test(sha));
	const results: PublishedCommitCheck[] = invalid.map(sha => ({ status: "UNKNOWN", sha, detail: "invalid cited commit SHA" }));
	if (valid.length === 0) return results;

	const runPublicationGit = async (args: string[]) => {
		try { return await execute(repo, args); }
		catch { return { rc: null, out: "", failed: true }; }
	};

	const fetched = await runPublicationGit(["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
	if (fetched.failed || fetched.rc !== 0) {
		return [...results, ...valid.map(sha => ({ status: "UNKNOWN" as const, sha, detail: "fresh origin/main fetch failed" }))];
	}
	const tip = await runPublicationGit(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
	if (tip.failed || tip.rc !== 0 || tip.out === "") {
		return [...results, ...valid.map(sha => ({ status: "UNKNOWN" as const, sha, detail: "fresh origin/main commit is unreadable" }))];
	}
	for (const sha of valid) {
		const commit = await runPublicationGit(["rev-parse", "--verify", `${sha}^{commit}`]);
		if (commit.failed || commit.rc !== 0 || commit.out === "") {
			results.push({ status: "UNKNOWN", sha, detail: "cited SHA does not resolve to a commit" });
			continue;
		}
		const ancestor = await runPublicationGit(["merge-base", "--is-ancestor", commit.out, tip.out]);
		if (ancestor.failed) results.push({ status: "UNKNOWN", sha, detail: "ancestry check failed" });
		else if (ancestor.rc === 0) results.push({ status: "PUBLISHED", sha, detail: "reachable from freshly fetched origin/main" });
		else if (ancestor.rc === 1) results.push({ status: "NOT_PUBLISHED", sha, detail: "not reachable from freshly fetched origin/main" });
		else results.push({ status: "UNKNOWN", sha, detail: "ancestry check failed" });
	}
	return results;
}
