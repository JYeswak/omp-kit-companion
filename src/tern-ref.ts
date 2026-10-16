import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { control } from "./tern/transport.ts";
import type { CliResult, ParsedCommand } from "./cli.ts";

/** Version-pinned local reference for the Tern Plugin SDK (ompkit-fp72.120.8 TERNREF1).
 *
 * Build/query/validate/drift orchestrate the embedding skill's pipeline
 * (crawl, extract, index, search, evaluate, label); this module owns the
 * Tern-specific rules the pilot proved necessary: start-URL normalization
 * (the skill crawler drops a trailing slash, so relative links 404),
 * print.html exclusion, per-member tern.d.luau chunking, a version-keyed
 * manifest, drift diffs, and cited-bead matching. Nothing here writes
 * outside the chosen state root or scratch.
 *
 * Regex note (regex-engineering §7): the three declaration patterns below
 * run in the shipping engine (Bun/JavaScriptCore native RegExp), anchored
 * at line start with exclusive ASCII classes and no nested quantifiers, so
 * matching is input-linear. Conformance lives in tests/cli/tern-ref.test.ts:
 * a required match, a reject/boundary case, and a timed long near-miss per
 * pattern. Untrusted file input is capped at MAX_LUAU_BYTES before any
 * pattern runs. */

export class TernRefInputError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "TernRefInputError";
	}
}

/** Cap for luau source fed to the chunker; the installed tern.d.luau is ~100 KiB. */
export const MAX_LUAU_BYTES = 4 * 1024 * 1024;

export const DOCS_ORIGIN = "https://docs.stencil.so";

/** Normalize a crawl start URL so relative links resolve under its path.
 *
 * WHATWG URL resolution treats a directory path without a trailing slash as
 * a file: new URL("install.html", "https://docs.stencil.so/tern").href drops
 * the "tern" segment. The skill crawler stores the start URL verbatim, so a
 * slashless directory start silently 404s every relative link. A trailing
 * slash is appended only when the last segment looks like a directory (no
 * dot); file URLs such as .../tern/index.html already resolve correctly and
 * must not gain one. The upstream crawler defect is filed separately and
 * never edited here. */
export function normalizeStartUrl(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new TernRefInputError("INVALID_START_URL", `Start URL is not a valid absolute URL: ${raw}`);
	}
	const segments = parsed.pathname.split("/");
	const last = segments[segments.length - 1] ?? "";
	if (last !== "" && !last.includes(".") && !parsed.pathname.endsWith("/")) parsed.pathname += "/";
	return parsed.href;
}

/** Resolve an href the way the skill crawler does (verbatim WHATWG join).
 * Exposed so the planted-negative test pins the slashless misresolution. */
export function resolveCrawlLink(startUrl: string, href: string): string {
	return new URL(href, startUrl).href;
}

/** True for the per-page print view that duplicates every docs page. */
export function isPrintHtml(url: string): boolean {
	let path: string;
	try {
		path = new URL(url).pathname;
	} catch {
		return false;
	}
	return path === "/print.html" || path.endsWith("/print.html");
}

export interface LuauMember {
	/** Declared member name, e.g. "PluginInfo", "SessionsCx", or "tern". */
	name: string;
	/** Declaration form that opened the member. */
	kind: "type" | "declare" | "module";
	/** 1-based line of the opening declaration. */
	line: number;
	/** Member text: carried `---` doc lines plus the declaration block. */
	text: string;
}

const TYPE_OPENER = /^export type ([A-Za-z_][A-Za-z0-9_]*)/;
const DECLARE_OPENER = /^declare(?: extern)? type ([A-Za-z_][A-Za-z0-9_]*)/;
const MODULE_OPENER = /^declare ([A-Za-z_][A-Za-z0-9_]*)\s*:/;

/** Split a tern.d.luau copy into one chunk per declared member.
 *
 * A member starts at a column-0 `export type NAME`, `declare ... NAME`, or
 * `declare NAME:` module-block line; the contiguous `---` doc lines directly
 * above it ride along and the parent type name is the declared name. The
 * module block matters most: `declare tern:` holds the whole plugin surface.
 * Paragraph splitting (the pilot's defect) would shred table-like type bodies
 * across chunks; this keeps each declaration whole. Throws when no member
 * opens, so an empty or foreign file never indexes as one silent blob. */
export function chunkLuauMembers(text: string): LuauMember[] {
	if (text.length > MAX_LUAU_BYTES) throw new TernRefInputError("LUAU_TOO_LARGE", `Luau source is ${text.length} bytes; cap is ${MAX_LUAU_BYTES}`);
	const lines = text.split("\n");
	const members: LuauMember[] = [];
	let current: { name: string; kind: "type" | "declare" | "module"; line: number; start: number } | null = null;
	const flush = (end: number): void => {
		if (current) {
			members.push({ ...current, text: lines.slice(current.start, end).join("\n").trimEnd() });
			current = null;
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		const typeMatch = TYPE_OPENER.exec(line);
		const declareMatch = typeMatch === null ? DECLARE_OPENER.exec(line) : null;
		const moduleMatch = typeMatch === null && declareMatch === null ? MODULE_OPENER.exec(line) : null;
		const match = typeMatch ?? declareMatch ?? moduleMatch;
		if (match === null) continue;
		let start = i;
		while (start > 0 && (lines[start - 1] as string).startsWith("---")) start--;
		flush(start);
		current = { name: match[1] as string, kind: typeMatch !== null ? "type" : declareMatch !== null ? "declare" : "module", line: i + 1, start };
	}
	flush(lines.length);
	if (members.length === 0) throw new TernRefInputError("NO_LUAU_MEMBERS", "No top-level export type or declare block opens; refusing to index as one blob");
	return members;
}

export interface TernRefPage {
	url: string;
	etag: string | null;
	sha256: string;
}

export interface TernRefManifest {
	manifest_version: 1;
	tern_version: string;
	tern_commit: string;
	pages: TernRefPage[];
	chunk_count: number;
	chunk_sha256: string[];
	index_model: string;
	built_at: string;
}

function manifestFields(value: object): TernRefManifest | null {
	const v = value as Record<string, unknown>;
	if (v.manifest_version !== 1) return null;
	for (const field of ["tern_version", "tern_commit", "index_model", "built_at"]) {
		if (typeof v[field] !== "string" || (v[field] as string).length === 0) return null;
	}
	if (!Array.isArray(v.pages) || !v.pages.every((p) => typeof p === "object" && p !== null &&
		typeof (p as Record<string, unknown>).url === "string" &&
		typeof (p as Record<string, unknown>).sha256 === "string" &&
		((p as Record<string, unknown>).etag === null || typeof (p as Record<string, unknown>).etag === "string"))) return null;
	if (typeof v.chunk_count !== "number" || !Array.isArray(v.chunk_sha256) || !v.chunk_sha256.every((s) => typeof s === "string")) return null;
	return v as unknown as TernRefManifest;
}

/** Parse and validate a manifest; unknown shapes refuse, never coerce. */
export function parseManifest(text: string): TernRefManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new TernRefInputError("INVALID_MANIFEST", "Manifest is not JSON");
	}
	if (typeof parsed !== "object" || parsed === null) throw new TernRefInputError("INVALID_MANIFEST", "Manifest needs manifest_version 1");
	const manifest = manifestFields(parsed);
	if (!manifest) throw new TernRefInputError("INVALID_MANIFEST", "Manifest shape is not a tern-ref manifest v1");
	return manifest;
}

/** Canonical manifest bytes: stable key order, one JSON shape. */
export function formatManifest(manifest: TernRefManifest): string {
	return JSON.stringify(manifest, ["manifest_version", "tern_version", "tern_commit", "pages", "url", "etag", "sha256", "chunk_count", "chunk_sha256", "index_model", "built_at"], 2) + "\n";
}

export interface ManifestDiff {
	version_changed: boolean;
	changed_urls: string[];
	added_chunk_sha256: string[];
	removed_chunk_sha256: string[];
	needs_reindex: boolean;
}

/** Diff two manifests for the drift step. A changed tern version or any
 * changed page forces a re-index; changed chunk hashes name what moved. */
export function diffManifests(oldManifest: TernRefManifest, newManifest: TernRefManifest): ManifestDiff {
	const version_changed = oldManifest.tern_version !== newManifest.tern_version || oldManifest.tern_commit !== newManifest.tern_commit;
	const oldPages: Record<string, TernRefPage> = {};
	for (const p of oldManifest.pages) oldPages[p.url] = p;
	const changed_urls = newManifest.pages.filter((p) => {
		const prev = oldPages[p.url];
		return !prev || prev.sha256 !== p.sha256 || prev.etag !== p.etag;
	}).map((p) => p.url);
	const oldChunks = new Set(oldManifest.chunk_sha256);
	const newChunks = new Set(newManifest.chunk_sha256);
	return {
		version_changed,
		changed_urls,
		added_chunk_sha256: [...newChunks].filter((s) => !oldChunks.has(s)),
		removed_chunk_sha256: [...oldChunks].filter((s) => !newChunks.has(s)),
		needs_reindex: version_changed || changed_urls.length > 0,
	};
}

export interface CitedBead {
	bead: string;
	anchor: string;
}

/** Find beads whose id, title, or description cites a changed chunk anchor.
 * Items are matched as opaque records (id plus every string field), so the
 * matcher survives `br list --json` shape drift; hits are listed only. */
export function matchCitedBeads(brListJson: string, anchors: string[]): CitedBead[] {
	let items: unknown;
	try {
		items = JSON.parse(brListJson);
	} catch {
		throw new TernRefInputError("INVALID_BEAD_LIST", "Bead list is not JSON");
	}
	if (!Array.isArray(items)) throw new TernRefInputError("INVALID_BEAD_LIST", "Bead list is not an array");
	const hits: CitedBead[] = [];
	for (const item of items) {
		if (typeof item !== "object" || item === null || typeof (item as Record<string, unknown>).id !== "string") continue;
		const haystack = Object.values(item as Record<string, unknown>).filter((v) => typeof v === "string").join("\n").toLowerCase();
		for (const anchor of anchors) {
			if (anchor.length > 0 && haystack.includes(anchor.toLowerCase())) hits.push({ bead: (item as Record<string, unknown>).id as string, anchor });
		}
	}
	return hits;
}

/** Resolve the kit-owned tern-ref state root: explicit --root, the env
 * override, or the platform state dir. Never the live daemon's dirs. */
export function resolveTernRefRoot(explicit?: string, env: Record<string, string | undefined> = process.env): string {
	const fromEnv = explicit ?? env.OMP_KIT_TERN_REF_ROOT;
	if (fromEnv !== undefined) {
		if (!fromEnv.startsWith("/")) throw new TernRefInputError("INVALID_STATE_ROOT", "tern-ref state root must be absolute");
		return fromEnv;
	}
	const base = env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith("/") ? env.XDG_STATE_HOME : `${env.HOME ?? "/tmp"}/.local/state`;
	return `${base}/omp-kit/tern-ref`;
}

/** Version-keyed reference dir beneath the state root. */
export function ternRefDirFor(root: string, ternVersion: string): string {
	if (!/^\d+\.\d+\.\d+$/.test(ternVersion)) throw new TernRefInputError("INVALID_TERN_VERSION", `Tern version is not x.y.z: ${ternVersion}`);
	return `${root}/${ternVersion}`;
}

/** Parse `tern --version` output ("tern 0.9.0 (56bd59f)"). */
export function parseTernVersion(output: string): { version: string; commit: string } {
	const match = /^tern (\d+\.\d+\.\d+) \(([0-9a-f]+)\)/m.exec(output.trim());
	if (!match) throw new TernRefInputError("BAD_TERN_VERSION", "tern --version did not print 'tern x.y.z (commit)'");
	return { version: match[1] as string, commit: match[2] as string };
}

const HELP_GROUP = /^\s*tern ((?:[a-z][a-z0-9-]*\|)+[a-z][a-z0-9-]*)/;

/** Enumerate script-command candidates from `tern --help` pipe groups.
 * Only groups directly after `tern ` qualify, so `tern plugin list|...`
 * never leaks plugin subcommands in. Wrapped lines ending in `|` join first. */
export function listTernCommands(helpText: string): string[] {
	const joined = helpText.replace(/\|\r?\n\s*/g, "|");
	const found: string[] = [];
	for (const line of joined.split("\n")) {
		const match = HELP_GROUP.exec(line);
		if (!match) continue;
		for (const name of (match[1] as string).split("|")) {
			if (!found.includes(name)) found.push(name);
		}
	}
	return found;
}

export interface CrawledPage {
	url: string;
	etag: string | null;
	sha256: string;
}

/** Read per-URL ETag/sha rows from a crawl pages.jsonl for the manifest and drift. */
export function readPagesIndex(pagesJsonl: string): CrawledPage[] {
	const pages: CrawledPage[] = [];
	for (const line of pagesJsonl.split("\n")) {
		if (line.trim() === "") continue;
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			throw new TernRefInputError("BAD_PAGES_JSONL", "pages.jsonl holds a non-JSON line");
		}
		if (typeof row !== "object" || row === null) throw new TernRefInputError("BAD_PAGES_JSONL", "pages.jsonl row is not an object");
		const r = row as Record<string, unknown>;
		if (typeof r.url !== "string" || typeof r.sha256 !== "string" || (r.etag !== null && r.etag !== undefined && typeof r.etag !== "string")) {
			throw new TernRefInputError("BAD_PAGES_JSONL", "pages.jsonl row needs {url, sha256, etag?}");
		}
		pages.push({ url: r.url, etag: (r.etag as string | null | undefined) ?? null, sha256: r.sha256 as string });
	}
	return pages;
}

export interface TernRefExecResult {
	exit: number | null;
	stdout: string;
	stderr: string;
}

export type TernRefExec = (argv: string[], opts?: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number }) => TernRefExecResult;

export interface TernRefFiles {
	read(path: string): string;
	write(path: string, content: string): void;
	mkdir(path: string): void;
	exists(path: string): boolean;
	remove(path: string): void;
	sha256Hex(content: string): string;
}

export interface TernRefOptions {
	root?: string;
	site?: string;
	force?: boolean;
	backend?: "nomic" | "qwen";
	k?: number;
}

export interface TernRefCommandResult {
	code: 0 | 1 | 2 | 3 | 4;
	data: Record<string, unknown>;
}

const EMBED_SCRIPTS = `${process.env.HOME ?? "/tmp"}/.claude/skills/embedding/scripts`;

/** Torch + sentence-transformers interpreter owning the cached Qwen weights. */
const QWEN_PYTHON = "/Volumes/ZestData/mathlas-index/serve-env/bin/python";

function checkQwenPython(files: TernRefFiles): void {
	if (!files.exists(QWEN_PYTHON)) {
		throw new TernRefInputError("QWEN_UNAVAILABLE", `Qwen backend needs ${QWEN_PYTHON}; qwen indexing reports UNAVAILABLE, never pass`);
	}
}

function defaultExec(argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {}): TernRefExecResult {
	const result = Bun.spawnSync(argv, {
		cwd: opts.cwd,
		env: opts.env ? { ...process.env, ...opts.env } : process.env,
		stdout: "pipe",
		stderr: "pipe",
		timeout: opts.timeoutMs,
	});
	return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function checkExec(result: TernRefExecResult, what: string): string {
	if (result.exit !== 0) throw new TernRefInputError("STEP_FAILED", `${what} exited ${String(result.exit)}: ${result.stderr.slice(0, 500)}`);
	return result.stdout;
}

/** Run `tern-ref build|query|validate|drift`. All writes stay under the
 * version-keyed state dir; validate's live daemon runs on a scratch socket
 * with a scratch TERN_CONFIG_DIR, never the live daemon's. */
export async function runTernRef(
	subcommand: string,
	args: Record<string, string | boolean>,
	opts: TernRefOptions = {},
	deps: {
		exec?: TernRefExec;
		files?: TernRefFiles;
		control?: (lines: string[], endpoint: string) => Promise<string[]>;
		spawn?: (argv: string[], env: Record<string, string | undefined>) => { kill(): void };
	} = {},
): Promise<TernRefCommandResult> {
	const exec = deps.exec ?? defaultExec;
	switch (subcommand) {
		case "build": return buildReference(args, opts, exec, deps.files);
		case "query": return queryReference(args, opts, exec, deps.files);
		case "validate": return validateReference(args, opts, exec, deps.files, deps.control, deps.spawn);
		case "drift": return driftReference(args, opts, exec, deps.files);
		default: throw new TernRefInputError("UNKNOWN_SUBCOMMAND", `tern-ref ${subcommand}: want build|query|validate|drift`);
	}
}

function versionDir(opts: TernRefOptions, exec: TernRefExec, files: TernRefFiles | undefined, wantVersion?: string): { dir: string; version: string; commit: string } {
	const root = resolveTernRefRoot(opts.root);
	const out = checkExec(exec(["tern", "--version"], { timeoutMs: 15000 }), "tern --version");
	const { version, commit } = parseTernVersion(out);
	if (wantVersion && wantVersion !== version) throw new TernRefInputError("VERSION_MISMATCH", `Reference is keyed by ${wantVersion}; installed tern is ${version}`);
	const dir = ternRefDirFor(root, version);
	if (files) files.mkdir(dir);
	return { dir, version, commit };
}

function buildReference(args: Record<string, string | boolean>, opts: TernRefOptions, exec: TernRefExec, files?: TernRefFiles): TernRefCommandResult {
	if (!files) throw new TernRefInputError("NO_FILES", "build needs a file seam");
	const { dir, version, commit } = versionDir(opts, exec, files);
	const manifestPath = `${dir}/manifest.json`;
	if (files.exists(manifestPath) && !opts.force && args["--force"] !== true) {
		return { code: 0, data: { status: "exists", dir, version } };
	}
	const site = normalizeStartUrl(typeof args["--site"] === "string" ? args["--site"] : `${DOCS_ORIGIN}/tern/index.html`);
	const rawDir = `${dir}/raw`;
	files.mkdir(rawDir);
	checkExec(exec(["python3", `${EMBED_SCRIPTS}/embed.py`, "crawl", "--site", site, "--out", rawDir, "--prefix", "/tern/", "--exclude", "/print.html", "--exclude", "/tern/print.html", "--delay", "0.5"], { timeoutMs: 600000 }), "crawl");
	const typesOut = checkExec(exec(["tern", "plugin", "types", `${dir}/types`], { timeoutMs: 60000 }), "tern plugin types");
	void typesOut;
	const luauText = files.read(`${dir}/types/tern.d.luau`);
	const members = chunkLuauMembers(luauText);
	files.mkdir(`${dir}/luau-members`);
	const sources: string[] = [];
	for (const member of members) {
		const file = `${dir}/luau-members/${member.name}.txt`;
		files.write(file, `${member.name} (${member.kind}, tern ${version}):\n${member.text}\n`);
		sources.push(`${file}\ttern-runtime://${version}-${commit}/tern.d.luau#${member.name}\ttern.d.luau member ${member.name}`);
	}
	const helpText = checkExec(exec(["tern", "--help"], { timeoutMs: 30000 }), "tern --help");
	const candidates = listTernCommands(helpText);
	files.mkdir(`${dir}/cli`);
	const kept: string[] = [];
	for (const cmd of candidates) {
		const probe = exec(["tern", cmd, "--help"], { timeoutMs: 30000 });
		if (probe.exit !== 0) continue;
		kept.push(cmd);
		const file = `${dir}/cli/tern-${cmd}.txt`;
		files.write(file, probe.stdout);
		sources.push(`${file}\ttern-cli://${version}-${commit}/tern-${cmd}\ttern ${cmd} --help (tern ${version})`);
	}
	files.write(`${dir}/sources.tsv`, `${sources.join("\n")}\n`);
	checkExec(exec(["python3", `${EMBED_SCRIPTS}/embed.py`, "extract", rawDir, `${dir}/luau-members`, `${dir}/cli`,
		"--sources", `${dir}/sources.tsv`, "--exclude-url", "*print.html*", "--out", `${dir}/corpus.jsonl`], { timeoutMs: 300000 }), "extract");
	checkExec(exec(["python3", `${EMBED_SCRIPTS}/embed.py`, "index", "--backend", "nomic", "--corpus", `${dir}/corpus.jsonl`, "--out", `${dir}/idx-nomic`], { timeoutMs: 600000 }), "index nomic");
	checkQwenPython(files);
	checkExec(exec([QWEN_PYTHON, `${EMBED_SCRIPTS}/embed.py`, "index", "--backend", "qwen", "--corpus", `${dir}/corpus.jsonl`, "--out", `${dir}/idx-qwen`], { timeoutMs: 1200000 }), "index qwen");
	const pages = readPagesIndex(files.read(`${rawDir}/pages.jsonl`)).filter((p) => !isPrintHtml(p.url));
	const corpusHashes = files.read(`${dir}/corpus.jsonl`).split("\n").filter((l) => l.trim() !== "").map((line) => {
		const row = JSON.parse(line) as { sha256?: unknown };
		if (typeof row.sha256 !== "string") throw new TernRefInputError("BAD_CORPUS", "corpus.jsonl chunk lacks sha256");
		return row.sha256;
	});
	const manifest: TernRefManifest = {
		manifest_version: 1, tern_version: version, tern_commit: commit,
		pages: pages.map((p) => ({ url: p.url, etag: p.etag, sha256: p.sha256 })),
		chunk_count: corpusHashes.length, chunk_sha256: corpusHashes,
		index_model: "nomic+qwen:unevaluated", built_at: new Date().toISOString(),
	};
	files.write(manifestPath, formatManifest(manifest));
	return { code: 0, data: { status: "built", dir, version, commit, members: members.length, commands: kept, chunks: corpusHashes.length } };
}

function queryReference(args: Record<string, string | boolean>, opts: TernRefOptions, exec: TernRefExec, files?: TernRefFiles): TernRefCommandResult {
	if (!files) throw new TernRefInputError("NO_FILES", "query needs a file seam");
	const { dir } = versionDir(opts, exec, files);
	const manifest = parseManifest(files.read(`${dir}/manifest.json`));
	const backend = opts.backend ?? (manifest.index_model.startsWith("nomic") ? "nomic" : "qwen");
	const indexDir = backend === "nomic" ? `${dir}/idx-nomic` : `${dir}/idx-qwen`;
	const k = opts.k ?? 10;
	const search = (query: string): unknown => {
		const out = checkExec(exec(["python3", `${EMBED_SCRIPTS}/embed.py`, "search", "--index", indexDir, query, "-k", String(k)], { timeoutMs: 120000 }), "search");
		return JSON.parse(out);
	};
	const frozen = args["--queries"];
	if (typeof frozen === "string") {
		const results = files.read(frozen).split("\n").filter((l) => l.trim() !== "").map((line) => {
			const row: unknown = JSON.parse(line);
			if (!row || typeof row !== "object" || !("qid" in row) || !("query" in row) || typeof row.qid !== "string" || typeof row.query !== "string") {
				throw new TernRefInputError("BAD_QUERIES", "queries.jsonl rows need {qid, query}");
			}
			return { qid: row.qid, hits: search(row.query) };
		});
		return { code: 0, data: { backend, results } };
	}
	const query = args["--query"];
	if (typeof query !== "string" || query.length === 0) throw new TernRefInputError("MISSING_QUERY", "query needs --query TEXT or --queries QUERIES.jsonl");
	return { code: 0, data: { backend, hits: search(query) } };
}

function validateReference(
	args: Record<string, string | boolean>,
	opts: TernRefOptions,
	exec: TernRefExec,
	files?: TernRefFiles,
	control?: (lines: string[], endpoint: string) => Promise<string[]>,
	spawn?: (argv: string[], env: Record<string, string | undefined>) => { kill(): void },
): Promise<TernRefCommandResult> | TernRefCommandResult {
	if (!files) throw new TernRefInputError("NO_FILES", "validate needs a file seam");
	const checks = args["--checks"];
	const queries = args["--queries"];
	if (typeof checks !== "string" && typeof queries !== "string") {
		throw new TernRefInputError("MISSING_CHECKS", "validate needs --checks CHECKS.jsonl and/or --queries QUERIES.jsonl");
	}
	const { dir, version } = versionDir(opts, exec, files);
	const runtime = typeof checks === "string" ? runRuntimeChecks(checks, dir, opts, exec, files, control, spawn) : Promise.resolve([]);
	return runtime.then((report) => {
		const scratch = `${resolveTernRefRoot(opts.root)}/validate-scratch`;
		const isolation = { socket: `${scratch}/ctl.sock`, config_dir: `${scratch}/config` };
		const planted = report.find((r) => r.planted === true);
		if (planted && planted.passed) throw new TernRefInputError("PLANTED_PASSED", `Planted false claim ${planted.id} reported pass; the check cannot tell true from false`);
		const failed = report.filter((r) => !r.planted && !r.passed);
		if (failed.length > 0) return { code: 1 as const, data: { status: "fail", failed: failed.map((f) => f.id), ...isolation } };
		if (typeof queries === "string") {
			const models = args["--label-models"];
			if (typeof models !== "string" || models.split(",").length !== 2) {
				throw new TernRefInputError("MISSING_LABELS", "retrieval eval needs --label-models FAMILY_A,FAMILY_B (two model families, never hardcoded)");
			}
			return runRetrievalEval(queries, models.split(","), dir, version, exec, files);
		}
		return { code: 0 as const, data: { status: "pass", checks: report.map((r) => r.id), ...isolation } };
	});
}

export interface RuntimeCheck {
	id: string;
	run: string[];
	expect: string[];
	planted?: boolean;
}

async function runRuntimeChecks(
	checksPath: string,
	dir: string,
	opts: TernRefOptions,
	exec: TernRefExec,
	files: TernRefFiles,
	control?: (lines: string[], endpoint: string) => Promise<string[]>,
	spawn?: (argv: string[], env: Record<string, string | undefined>) => { kill(): void },
): Promise<{ id: string; passed: boolean; planted: boolean }[]> {
	const lines = files.read(checksPath).split("\n").filter((l) => l.trim() !== "");
	const checks: RuntimeCheck[] = lines.map((line, n) => {
		const row = JSON.parse(line) as Partial<RuntimeCheck>;
		if (typeof row.id !== "string" || !Array.isArray(row.run) || !Array.isArray(row.expect)) {
			throw new TernRefInputError("BAD_CHECKS", `checks.jsonl line ${String(n + 1)} needs {id, run[], expect[]}`);
		}
		return { id: row.id, run: row.run, expect: row.expect, planted: row.planted ?? false };
	});
	const scratch = `${resolveTernRefRoot(opts.root)}/validate-scratch`;
	files.mkdir(scratch);
	const socket = `${scratch}/ctl.sock`;
	files.remove(socket);
	const server = (spawn ?? defaultSpawn)(["tern", "serve", "--control", socket], { ...process.env, TERN_CONFIG_DIR: `${scratch}/config` });
	try {
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			if (files.exists(socket)) break;
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 200);
			await promise;
		}
		if (!files.exists(socket)) throw new TernRefInputError("SERVE_UNAVAILABLE", "isolated tern serve never created its socket");
		if (!control) throw new TernRefInputError("NO_CONTROL", "validate needs a control seam");
		const report: { id: string; passed: boolean; planted: boolean }[] = [];
		for (const check of checks) {
			const replies = await control(check.run, socket);
			const text = replies.join("\n");
			report.push({ id: check.id, passed: check.expect.every((s) => text.includes(s)), planted: check.planted ?? false });
		}
		await control(["quit"], socket).catch(() => []);
		return report;
	} finally {
		server.kill();
	}
}

function defaultSpawn(argv: string[], env: Record<string, string | undefined>): { kill(): void } {
	const proc = Bun.spawn(argv, { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" });
	return { kill: () => proc.kill() };
}

export interface SystemGrades {
	correct: number;
	partial: number;
	miss: number;
}

/** Grade each system's rank-1 hit per query from two blind label sets.
 * sealedRunsJson is evaluate.py pool's sealed/runs.json; labels are label.py
 * outputs (item → 0|1|2). Rank-1 mean grade ≥ 1.5 is correct, ≥ 0.5 partial,
 * else a miss. Pure: unit-tested on a fixture packet. */
export function gradeRetrievalSystems(sealedRunsJson: string, labelsAJjsonl: string, labelsBJsonl: string): Record<string, SystemGrades> {
	const sealed = JSON.parse(sealedRunsJson) as { systems: { name: string }[]; queries: { qid: string }[]; runs: Record<string, Record<string, string[]>> };
	if (!Array.isArray(sealed.systems) || !Array.isArray(sealed.queries) || typeof sealed.runs !== "object") {
		throw new TernRefInputError("BAD_SEALED", "sealed runs.json is not an evaluate.py packet");
	}
	const grades: Record<string, number[]> = {};
	for (const jsonl of [labelsAJjsonl, labelsBJsonl]) {
		for (const line of jsonl.split("\n")) {
			if (line.trim() === "") continue;
			const row = JSON.parse(line) as { item?: unknown; grade?: unknown };
			if (typeof row.item !== "string" || (row.grade !== 0 && row.grade !== 1 && row.grade !== 2)) {
				throw new TernRefInputError("BAD_LABELS", "label rows need {item, grade 0|1|2}");
			}
			grades[row.item] = [...(grades[row.item] ?? []), row.grade];
		}
	}
	const mean = (item: string): number => {
		const list = grades[item] ?? [];
		if (list.length === 0) throw new TernRefInputError("UNLABELLED_ITEM", `pooled item has no labels: ${item}`);
		return list.reduce((a, b) => a + b, 0) / list.length;
	};
	const out: Record<string, SystemGrades> = {};
	for (const system of sealed.systems) {
		const tally: SystemGrades = { correct: 0, partial: 0, miss: 0 };
		for (const query of sealed.queries) {
			const top = sealed.runs[system.name]?.[query.qid]?.[0];
			if (!top) throw new TernRefInputError("EMPTY_RANK", `system ${system.name} ranked nothing for ${query.qid}`);
			const score = mean(top);
			if (score >= 1.5) tally.correct++;
			else if (score >= 0.5) tally.partial++;
			else tally.miss++;
		}
		out[system.name] = tally;
	}
	return out;
}

/** Retrieval gate: pool both indexes, blind-label with two model families,
 * score, and enforce kappa plus the pilot-baseline beat. Pilot (8 queries):
 * 5 correct, 2 partial, 1 miss. Winner needs a correct rate above 5/8 and a
 * correct+partial rate at or above 7/8 on the frozen set; ties go to nomic,
 * the cheaper backend. Pass updates the manifest's index_model and writes a
 * dated receipt. */
function runRetrievalEval(
	queriesPath: string,
	labelModels: string[],
	dir: string,
	version: string,
	exec: TernRefExec,
	files: TernRefFiles,
): TernRefCommandResult {
	const packetDir = `${dir}/eval-packet`;
	checkQwenPython(files);
	checkExec(exec([QWEN_PYTHON, `${EMBED_SCRIPTS}/evaluate.py`, "pool",
		"--queries", queriesPath, "--index", `nomic=${dir}/idx-nomic:hybrid`, "--index", `qwen=${dir}/idx-qwen:hybrid`, "-k", "10", "--out", packetDir],
		{ timeoutMs: 600000 }), "eval pool");
	const labelFiles = labelModels.map((model, n) => {
		const out = `${dir}/eval-labels-${n === 0 ? "a" : "b"}.jsonl`;
		checkExec(exec(["python3", `${EMBED_SCRIPTS}/label.py`, "--packet", packetDir, "--model", model, "--out", out, "--runner", "ci"],
			{ timeoutMs: 1800000 }), `label ${model}`);
		return out;
	});
	const scoreOut = checkExec(exec(["python3", `${EMBED_SCRIPTS}/evaluate.py`, "score", "--packet", packetDir, "--labels", labelFiles[0] as string, "--labels", labelFiles[1] as string],
		{ timeoutMs: 300000 }), "eval score");
	const score = JSON.parse(scoreOut) as { agreement?: { kappa_linear_weighted?: unknown }; queries?: unknown };
	const kappa = score.agreement?.kappa_linear_weighted;
	if (typeof kappa !== "number") throw new TernRefInputError("BAD_SCORE", "eval score printed no kappa");
	if (kappa < 0.4) throw new TernRefInputError("KAPPA_TOO_LOW", `blind labels too noisy to rank systems (kappa ${String(kappa)} < 0.4); fix the guidelines first`);
	const sealedJson = files.read(`${packetDir}/sealed/runs.json`);
	const sealedParsed: unknown = JSON.parse(sealedJson);
	const sealedQueries = sealedParsed && typeof sealedParsed === "object" && "queries" in sealedParsed ? sealedParsed.queries : undefined;
	const queryCount = Array.isArray(sealedQueries) ? sealedQueries.length : 0;
	const grades = gradeRetrievalSystems(sealedJson, files.read(labelFiles[0] as string), files.read(labelFiles[1] as string));
	const rate = (n: number): number => (queryCount === 0 ? 0 : n / queryCount);
	const ranked = Object.entries(grades).sort((a, b) => (b[1].correct - a[1].correct) || ((b[1].correct + b[1].partial) - (a[1].correct + a[1].partial)));
	const winner = ranked[0]?.[1].correct === ranked[1]?.[1].correct && ranked[0]?.[1].partial === ranked[1]?.[1].partial ? "nomic" : (ranked[0] as [string, SystemGrades])[0];
	const win = grades[winner] as SystemGrades;
	if (!(rate(win.correct) > 5 / 8 && rate(win.correct + win.partial) >= 7 / 8)) {
		throw new TernRefInputError("BASELINE_REGRESSION", `${winner} has ${String(win.correct)} correct of ${String(queryCount)}; pilot baseline is 5 of 8 with 7 of 8 at partial-or-better`);
	}
	const manifest = parseManifest(files.read(`${dir}/manifest.json`));
	manifest.index_model = winner;
	files.write(`${dir}/manifest.json`, formatManifest(manifest));
	const receipt = { receipt: "tern-ref-eval", tern_version: version, kappa, grades, winner, queries: queriesPath, at: new Date().toISOString() };
	files.write(`${dir}/eval-${version}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
	return { code: 0, data: { status: "pass", winner, kappa, grades } };
}

function driftReference(args: Record<string, string | boolean>, opts: TernRefOptions, exec: TernRefExec, files?: TernRefFiles): TernRefCommandResult {
	if (!files) throw new TernRefInputError("NO_FILES", "drift needs a file seam");
	const { dir, version } = versionDir(opts, exec, files);
	const stored = parseManifest(files.read(`${dir}/manifest.json`));
	const tmpRaw = `${dir}/drift-raw`;
	files.mkdir(tmpRaw);
	const site = normalizeStartUrl(typeof args["--site"] === "string" ? args["--site"] : `${DOCS_ORIGIN}/tern/index.html`);
	checkExec(exec(["python3", `${EMBED_SCRIPTS}/embed.py`, "crawl", "--site", site, "--out", tmpRaw, "--prefix", "/tern/", "--delay", "0.5"], { timeoutMs: 600000 }), "drift crawl");
	const fresh = readPagesIndex(files.read(`${tmpRaw}/pages.jsonl`)).filter((p) => !isPrintHtml(p.url));
	const storedByUrl: Record<string, string> = {};
	for (const p of stored.pages) storedByUrl[p.url] = `${p.etag ?? ""}|${p.sha256}`;
	const changed = fresh.filter((p) => storedByUrl[p.url] !== `${p.etag ?? ""}|${p.sha256}`).map((p) => p.url);
	if (changed.length === 0 && stored.tern_version === version) {
		return { code: 0, data: { status: "clean", version } };
	}
	const rebuilt = buildReference({ "--force": true }, opts, exec, files);
	const current = parseManifest(files.read(`${dir}/manifest.json`));
	const diff = diffManifests(stored, current);
	const beadList = checkExec(exec(["br", "list", "--json"], { timeoutMs: 60000 }), "br list");
	const anchors = [...diff.added_chunk_sha256.slice(0, 50), ...changed.slice(0, 50)];
	const cited = matchCitedBeads(beadList, anchors);
	return { code: 0, data: { status: "reindexed", version, changed_urls: changed, diff, cited, build: rebuilt.data } };
}

/** CLI adapter: `omp-kit tern-ref build|query|validate|drift`. Wires real
 * filesystem, spawn, and Tern control seams around runTernRef. Usage-shaped
 * input errors exit 2; step failures exit 3; unexpected failures exit 4. */
export async function ternRefCommand(request: ParsedCommand): Promise<CliResult> {
	const files: TernRefFiles = {
		read: (path) => readFileSync(path, "utf8"),
		write: (path, content) => writeFileSync(path, content),
		mkdir: (path) => mkdirSync(path, { recursive: true }),
		exists: (path) => existsSync(path),
		remove: (path) => rmSync(path, { force: true }),
		sha256Hex: (content) => createHash("sha256").update(content).digest("hex"),
	};
	const subcommand = request.parent ? request.command.name : (request.argument ?? "");
	const flag = (name: string): string | undefined => {
		const value = request.flags.get(name);
		return typeof value === "string" ? value : undefined;
	};
	const backend = flag("--backend");
	if (backend !== undefined && backend !== "nomic" && backend !== "qwen") {
		return { code: 2, data: { overall: "NOT_RUN" }, errors: [{ code: "TERNREF_USAGE", message: "--backend wants nomic|qwen", remediation: "Pass --backend nomic or --backend qwen." }], verification: "NOT_RUN" };
	}
	const args: Record<string, string | boolean> = {};
	for (const name of ["--site", "--query", "--queries", "--checks", "--label-models"]) {
		const value = flag(name);
		if (value !== undefined) args[name] = value;
	}
	for (const name of ["--force"]) {
		if (request.flags.has(name)) args[name] = true;
	}
	try {
		const result = await runTernRef(subcommand, args, {
			root: flag("--root"),
			force: request.flags.has("--force"),
			backend,
			k: flag("--k") === undefined ? undefined : Number(flag("--k")),
		}, {
			files,
			control: async (lines, endpoint) => {
				const { replies } = await control(lines, { endpoint, timeoutMs: 25000 });
				return replies.map((r) => JSON.stringify(r));
			},
		});
		return { ...result, verification: "PERFORMED" as const };
	} catch (error) {
		if (error instanceof TernRefInputError) {
			const usageCodes = ["UNKNOWN_SUBCOMMAND", "MISSING_QUERY", "MISSING_CHECKS", "MISSING_LABELS", "INVALID_START_URL", "INVALID_STATE_ROOT", "INVALID_TERN_VERSION", "VERSION_MISMATCH"];
			return {
				code: (usageCodes.includes(error.code) ? 2 : 3) as 2 | 3,
				data: { overall: "NOT_RUN" },
				errors: [{ code: error.code, message: error.message, remediation: "Run omp-kit tern-ref --help for the grammar; inputs stay absolute and version-pinned." }],
				verification: "NOT_RUN",
			};
		}
		return { code: 4, data: { overall: "UNVERIFIED" }, errors: [{ code: "TERNREF_FAILED", message: error instanceof Error ? error.message : String(error), remediation: "Inspect the step output above; state under the version dir is left for triage." }], verification: "UNVERIFIED" };
	}
}
