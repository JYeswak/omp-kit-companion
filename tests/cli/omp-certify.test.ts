import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// OMP certification decides merge vs agent-fix. A pinned-source tuple qualifies when it is already on main, or when
// two model families both judge every changed file non-semantic and cite changed lines; everything else, a failed
// suite, or a missing key becomes an agent-fix issue. This drives the real script against synthetic packages,
// synthetic pin sources, and a local OpenAI-compatible gateway.
const REPO_ROOT = join(import.meta.dir, "..", "..");
const root = mkdtempSync(join(tmpdir(), "omp-kit-certify-"));
const CHANGED_LINE = "export const retainTurns = 2;";
let mode: "agree" | "disagree" | "bad-citation" = "agree";
let server: Server;

beforeAll(() => {
	server = Bun.serve({
		port: 0, hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			const model = (id: string, owner: string, price: string) => ({ id, owned_by: owner, type: "text", supported_endpoints: ["/v1/chat/completions"],
				capabilities: { reasoning: true }, available_until: null, context_length: 128_000, pricing: { input_per_million: price, output_per_million: price } });
			if (url.pathname === "/v1/models") return Response.json({ data: [model("alpha-1", "Alpha", "5"), model("alpha-2", "Alpha", "4"), model("beta-1", "Beta", "3")] });
			const payload = await request.json() as { model: string; messages: { role: string; content: string }[] };
			const reviewer = payload.messages[0]!.content.includes('"qualifies"');
			const cited = [mode === "bad-citation" ? "this line is not in the diff" : `+${CHANGED_LINE}`];
			const reply = reviewer
				? { qualifies: mode !== "disagree", cited_lines: cited, reasoning: `reviewer ${payload.model}` }
				: { semantic_change: false, summary: `advisory ${payload.model}`, risks: [], cited_lines: cited };
			return Response.json({ model: payload.model, choices: [{ message: { content: JSON.stringify(reply) } }] }, { headers: { "x-ci-request-id": `req-${payload.model}` } });
		},
	});
});
afterAll(() => { server.stop(true); rmSync(root, { recursive: true, force: true }); });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const READINESS_FILES = ["src/memory-backend/settings.ts", "src/memory-backend/resolve.ts", "src/config/settings.ts"];
const OLD = { settings: "export const backend = \"off\";\n", resolve: "export const fallback = \"noop\";\n", config: "export const retainTurns = 1;\n", redact: "export const redact = 1;\n", db: "export const schema = 1;\n" };
const NEW_CONFIG = `${CHANGED_LINE}\n`;

/** A throwaway repo: the real script, a compat file, pin sources in the product's layout, and two npm-pack-shaped releases. */
function fixture(name: string, reviewedConfigs: string[]): string {
	const repo = join(root, name);
	mkdirSync(join(repo, "scripts"), { recursive: true });
	mkdirSync(join(repo, "src"), { recursive: true });
	cpSync(join(REPO_ROOT, "scripts", "omp-certify.ts"), join(repo, "scripts", "omp-certify.ts"));
	writeFileSync(join(repo, "scripts", "omp-compat.json"), JSON.stringify({ minimum: "1.0.0", certified: "1.0.0" }) + "\n");
	const fingerprints = reviewedConfigs.map(config => `\t"${sha(OLD.settings)}:${sha(OLD.resolve)}:${sha(config)}",`).join("\n");
	writeFileSync(join(repo, "src", "memory-readiness.ts"), [
		`const MEMORY_CONFIG_SOURCE_FINGERPRINTS = new Set([\n${fingerprints}\n]);`,
		`const MEMORY_CONFIG_SOURCE_FILES = [\n${READINESS_FILES.map(path => `\t"${path}",`).join("\n")}\n] as const;`,
		`const REDACTOR_SOURCE_SHA256 = "${sha(OLD.redact)}";`, "function memoryConfigSourcesReviewed() {}", "",
	].join("\n"));
	writeFileSync(join(repo, "src", "memory-audit.ts"),
		`const REVIEWED_SOURCE_PIN_SETS: readonly (readonly SourcePin[])[] = [\n\t[\n\t\t["mnemopi", "src/db.ts", "${sha(OLD.db)}"],\n\t],\n];\nfunction matchesReviewedSourcePins() {}\n`);
	for (const [version, config] of [["1.0.0", OLD.config], ["1.1.0", NEW_CONFIG]] as const) {
		const files: Record<string, Record<string, string>> = {
			agent: { [READINESS_FILES[0]!]: OLD.settings, [READINESS_FILES[1]!]: OLD.resolve, [READINESS_FILES[2]!]: config, "src/memory-backend/redact.ts": OLD.redact,
				"package.json": JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }) },
			mnemopi: { "src/db.ts": OLD.db, "package.json": JSON.stringify({ name: "@oh-my-pi/pi-mnemopi", version }) },
		};
		for (const [pkg, contents] of Object.entries(files)) for (const [path, text] of Object.entries(contents)) {
			const target = join(repo, "work", version, pkg, "package", path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, text);
		}
	}
	return repo;
}

async function script(repo: string, args: string[], env: Record<string, string | undefined> = {}) {
	const child = Bun.spawn([process.execPath, join(repo, "scripts", "omp-certify.ts"), ...args], {
		env: { ...process.env, CHEAPER_INFERENCE_API_KEY: "test-key", CHEAPER_INFERENCE_BASE_URL: `http://127.0.0.1:${server.port}/v1`, OMP_REVIEW_MODEL: "", OMP_REVIEWER_MODEL: "", ...env },
		stdout: "pipe", stderr: "pipe",
	});
	const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect(code, stdout + stderr).toBe(0);
}

interface Outcome { eligible: boolean; reasons: string[]; issue: { title: string; body: string } | null; readiness: string; review: { models: Record<string, { id: string | null; selection: string }> } }
async function certify(repo: string, env: Record<string, string | undefined> = {}, suites = "success"): Promise<Outcome> {
	await script(repo, ["review", "--from", "1.0.0", "--to", "1.1.0", "--work", join(repo, "work"), "--out", join(repo, "review.json")], env);
	await script(repo, ["apply", "--review", join(repo, "review.json")]);
	writeFileSync(join(repo, "table.md"), "| Check | 1.1.0 |\n");
	writeFileSync(join(repo, "regressions.json"), "[]");
	await script(repo, ["body", "--review", join(repo, "review.json"), "--pr", "7", "--suites-result", suites, "--suite-sha", "0".repeat(40),
		"--run-url", "https://example.invalid/run", "--key", "k", "--differential-table", join(repo, "table.md"),
		"--differential-regressions", join(repo, "regressions.json"), "--body-out", join(repo, "body.md"),
		"--decision-out", join(repo, "decision.json"), "--issue-out", join(repo, "issue.json")]);
	const decision = JSON.parse(readFileSync(join(repo, "decision.json"), "utf8")) as { eligible: boolean; reasons: string[] };
	let issue: Outcome["issue"] = null;
	try { issue = JSON.parse(readFileSync(join(repo, "issue.json"), "utf8")); } catch { issue = null; }
	return { ...decision, issue, readiness: readFileSync(join(repo, "src", "memory-readiness.ts"), "utf8"), review: JSON.parse(readFileSync(join(repo, "review.json"), "utf8")) };
}

test("two model families agree and cite the changed line: tuple inserted, merge eligible", async () => {
	mode = "agree";
	const outcome = await certify(fixture("agree", [OLD.config]));
	expect(outcome.review.models.advisory!.id).toBe("alpha-1");
	expect(outcome.review.models.reviewer!.id).toBe("beta-1");
	expect(outcome).toMatchObject({ eligible: true, reasons: [], issue: null });
	expect(outcome.readiness).toContain(`"${sha(OLD.settings)}:${sha(OLD.resolve)}:${sha(NEW_CONFIG)}",`);
	expect(outcome.readiness).toContain("x-ci-request-id req-alpha-1; beta-1 x-ci-request-id req-beta-1");
});

test("reviewer disagrees: no tuple inserted, agent-fix issue names the file and code path", async () => {
	mode = "disagree";
	const outcome = await certify(fixture("disagree", [OLD.config]));
	expect(outcome.eligible).toBe(false);
	expect(outcome.readiness).not.toContain(sha(NEW_CONFIG));
	expect(outcome.issue!.title).toBe("OMP 1.1.0: memory semantics changed in src/config/settings.ts");
	expect(outcome.issue!.body).toContain("`src/memory-readiness.ts:1` MEMORY_CONFIG_SOURCE_FINGERPRINTS");
	expect(outcome.issue!.body).toContain(`+${CHANGED_LINE}`);
	expect(outcome.issue!.body).toContain("reviewer `beta-1`");
});

test("verdicts that cite lines absent from the diff do not qualify", async () => {
	mode = "bad-citation";
	const outcome = await certify(fixture("bad-citation", [OLD.config]));
	expect(outcome.eligible).toBe(false);
	expect(outcome.issue!.body).toContain("citations INVALID");
});

test("a reviewer from the advisory model's family is refused", async () => {
	mode = "agree";
	const outcome = await certify(fixture("same-family", [OLD.config]), { OMP_REVIEW_MODEL: "alpha-1", OMP_REVIEWER_MODEL: "alpha-2" });
	expect(outcome.eligible).toBe(false);
	expect(outcome.review.models.reviewer!.selection).toContain("same model family (alpha)");
	expect(outcome.readiness).not.toContain(sha(NEW_CONFIG));
	expect(outcome.issue!.title).toContain("src/config/settings.ts");
});

test("no gateway key: agent-fix with the reason", async () => {
	const outcome = await certify(fixture("no-key", [OLD.config]), { CHEAPER_INFERENCE_API_KEY: undefined });
	expect(outcome.eligible).toBe(false);
	expect(outcome.issue!.body).toContain("CHEAPER_INFERENCE_API_KEY is not set");
});

test("changed bytes whose tuple is already reviewed on main need no agent review and merge", async () => {
	mode = "disagree";
	const outcome = await certify(fixture("on-main", [OLD.config, NEW_CONFIG]));
	expect(outcome).toMatchObject({ eligible: true, reasons: [], issue: null });
	expect(outcome.review.models.advisory!.id).toBeNull();
});

test("a failed suite blocks the merge even when both families qualify the change", async () => {
	mode = "agree";
	const outcome = await certify(fixture("suite-failed", [OLD.config]), {}, "failure");
	expect(outcome.eligible).toBe(false);
	expect(outcome.reasons).toEqual(["ci.yml suites on the candidate tree: failure"]);
	expect(outcome.issue!.title).toBe("OMP 1.1.0: certification blocked (ci.yml suites on the candidate tree)");
});
