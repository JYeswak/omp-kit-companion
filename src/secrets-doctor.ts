/** secrets-doctor.ts — doctor --scope secrets (ompkit-l8h5 item 4): no plaintext vault values on disk.
 *
 * Every readable Infisical secret value is fetched through the operator's existing identity path
 * (~/.local/share/infisical-helpers/lib.sh: identity file + Keychain client secret + universal-auth
 * login), hashed immediately, and dropped: only sha256 digests and the value lengths stay in memory.
 * Files under the scan roots are tokenized and each candidate token whose length matches a vault
 * value is hashed and looked up. Findings name the file and the vault secret NAME(s), never a value.
 * Infisical unreachable means UNVERIFIED, never PASS.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, type Stats } from "node:fs";
import { basename, delimiter, extname, join, relative, resolve } from "node:path";

export const MIN_SECRET_LENGTH = 16;
const MAX_FILE_BYTES = 1_048_576;
const MAX_FILES = 1_000_000;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 8192;

/** Digest of a vault value -> labels ("project/env:NAME"). Values themselves are never kept. */
export interface DigestSet { digests: Map<string, Set<string>>; lengths: Set<number>; source: string; projects: number; failed: string[] }
export type DigestResult = { status: "OK"; set: DigestSet } | { status: "UNREACHABLE"; reason: string };

export interface SecretHit { path: string; names: string[] }
/** One rc file holding literal secret-shaped exports. `names` are variable NAMES only, never values. */
export interface RcSecretHit { path: string; names: string[] }
export interface SecretsReport {
	scope: "secrets";
	overall: "PASS" | "FAIL" | "UNVERIFIED";
	mode: "roots" | "staged";
	digest_source: string;
	vault_projects: number;
	vault_digests: number;
	failed_vault_reads: string[];
	roots: string[];
	hits: SecretHit[];
	tmux_secret_names: string[];
	/** Literal secret-shaped exports in shell rc files (ompkit-3h11 NOAMBIENT1). Names only. */
	rc_secret_hits: RcSecretHit[];
	/** Non-allowlisted secret-shaped names in the live process environment. Names only. */
	live_process_secret_names: string[];
	/** Local omp processes still running on a pre-guard environment (respawn needed). */
	live_process_count: number | null;
	files_scanned: number;
	bytes_scanned: number;
	skipped_large: number;
	truncated: boolean;
	reason: string | null;
	text: string;
}

export function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function addValue(set: DigestSet, value: string, label: string): void {
	const candidates = new Set<string>([value.trim()]);
	// A multi-line value (PEM, JSON) never appears as one token; its long lines can. PEM armor and
	// JSON punctuation lines are public boilerplate shared by every key, so they are not candidates.
	if (value.includes("\n")) for (const line of value.split(/\r?\n/)) if (!/^-----(?:BEGIN|END) /.test(line.trim()) && /[A-Za-z0-9]{16}/.test(line)) candidates.add(line.trim());
	for (const candidate of candidates) {
		if (candidate.length < MIN_SECRET_LENGTH || candidate.length > MAX_TOKEN_LENGTH) continue;
		const digest = sha256(candidate);
		let labels = set.digests.get(digest);
		if (!labels) set.digests.set(digest, labels = new Set());
		labels.add(label);
		set.lengths.add(candidate.length);
	}
}

/** Test seam and offline fixture format: one `sha256hex<TAB>LABEL` per line. Never holds values. */
export function digestSetFromFile(path: string): DigestSet {
	const set: DigestSet = { digests: new Map(), lengths: new Set(), source: `file:${path}`, projects: 0, failed: [] };
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const [digest, label, length] = line.split("\t");
		if (!digest || !label || !/^[0-9a-f]{64}$/.test(digest)) continue;
		const labels = set.digests.get(digest) ?? new Set<string>();
		labels.add(label);
		set.digests.set(digest, labels);
		const n = Number(length);
		if (Number.isInteger(n) && n >= MIN_SECRET_LENGTH) set.lengths.add(n);
	}
	// Without recorded lengths every admissible length is a candidate.
	if (set.lengths.size === 0) for (let n = MIN_SECRET_LENGTH; n <= 512; n++) set.lengths.add(n);
	return set;
}

/**
 * Bash half of the live fetch: lib.sh owns identity and login (one login per run); the token goes
 * to curl on stdin (`-H @-`), never argv. Readable projects come from the workspace listing, else
 * the identity's INFISICAL_PROJECT_IDS. Output frames: `R <id> <slug> <env> <rc>` followed by that
 * secrets body on one line. Bodies flow only through this pipe into the hasher below.
 */
const FETCH_SCRIPT = String.raw`
set -u
lib="$HOME/.local/share/infisical-helpers/lib.sh"
[ -r "$lib" ] || { echo "E infisical-helpers lib.sh missing"; exit 3; }
. "$lib"
( inf_load_identity zeststream ) >/dev/null 2>&1 || { echo "E identity unavailable (identity file or Keychain client secret)"; exit 3; }
inf_load_identity zeststream >/dev/null 2>&1
inf_login >/dev/null 2>&1 || { echo "E universal-auth login failed (Infisical unreachable or identity rejected)"; exit 3; }
get() { printf 'Authorization: Bearer %s\n' "$INFISICAL_TOKEN" | timeout "$INF_OP_TIMEOUT" curl -sS -f -A infisical-helpers/v3-fallback -H @- "$INFISICAL_API_URL/$1" 2>/dev/null | tr -d '\n'; }
projects=$(get api/v1/workspace | python3 -c 'import json,sys
d=json.load(sys.stdin)
for w in d.get("workspaces") or d.get("projects") or []: print(w["id"], w.get("slug") or w["id"])' 2>/dev/null)
[ -n "$projects" ] || projects=$(printf '%s' "$INFISICAL_PROJECT_IDS" | tr ',' '\n' | awk 'NF {print $1, $1}')
[ -n "$projects" ] || { echo "E no readable Infisical project"; exit 3; }
printf '%s\n' "$projects" | while read -r id slug; do
	for env in prod dev staging; do
		body=$(get "api/v3/secrets/raw?workspaceId=$id&environment=$env&secretPath=/&recursive=true&include_imports=true"); echo "R $id $slug $env $?"; printf '%s\n' "$body"; body=""
	done
done
`;

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function liveDigestSource(home = process.env.HOME ?? ""): DigestResult {
	const fetched = spawnSync("bash", ["-c", FETCH_SCRIPT], { encoding: "utf8", timeout: 300_000, env: { ...process.env, HOME: home }, maxBuffer: 256 * 1_048_576 });
	if (fetched.status !== 0) return { status: "UNREACHABLE", reason: String(fetched.stdout ?? "").split("\n").find(line => line.startsWith("E "))?.slice(2) ?? `fetch exited ${fetched.status ?? "by signal"}` };
	const projects = new Map<string, string>();
	const set: DigestSet = { digests: new Map(), lengths: new Set(), source: "infisical", projects: 0, failed: [] };
	const okProjects = new Set<string>();
	const out = String(fetched.stdout).split("\n");
	for (let i = 0; i < out.length; i++) {
		const head = /^R (\S+) (\S+) (\S+) (\d+)$/.exec(out[i] ?? "");
		if (!head) continue;
		const [, id = "", slug = "", env = "", rc] = head;
		projects.set(id, slug);
		const body = out[++i] ?? "";
		if (rc !== "0") continue;
		try {
			const parsed: unknown = JSON.parse(body);
			if (!record(parsed)) continue;
			const groups: unknown[] = [parsed.secrets, ...(Array.isArray(parsed.imports) ? parsed.imports.map(item => record(item) ? item.secrets : undefined) : [])];
			// Vault entries named like pointers or identities (ORG_ID, SMTP_USER, SUPABASE_URL, *_LOGIN) are
			// shared config, not credentials; matching them made the first live run list docs and patches.
			// A URL carrying user:password@ is a credential whatever its name (DATABASE_URL).
			for (const group of groups) if (Array.isArray(group)) for (const secret of group) {
				if (!record(secret) || typeof secret.secretKey !== "string" || typeof secret.secretValue !== "string") continue;
				addSecretValueToDigestSet(set, secret.secretKey, secret.secretValue, `${projects.get(id) ?? id}/${env}:${secret.secretKey}`);
			}
			okProjects.add(id);
		} catch { /* An unparsable body counts as an unread project/env. */ }
	}
	out.length = 0;
	set.projects = okProjects.size;
	set.failed = [...projects].filter(([id]) => !okProjects.has(id)).map(([, name]) => name);
	if (okProjects.size === 0) return { status: "UNREACHABLE", reason: "every Infisical project read failed" };
	return { status: "OK", set };
}

/** Candidate substrings of one token that could be a whole value: the token, and the right side of KEY=, KEY: */
function* candidates(token: string): Generator<string> {
	yield token;
	const eq = token.indexOf("=");
	if (eq > 0) yield token.slice(eq + 1);
	const colon = token.indexOf(":");
	if (colon > 0) yield token.slice(colon + 1);
}

const TOKEN_SPLIT = /[\s"'`,;<>(){}[\]\\|]+/;

/** Every vault label whose value occurs in `text` as a delimited token or as a whole assignment value. */
export function findSecretNames(text: string, set: DigestSet): string[] {
	const names = new Set<string>();
	const check = (candidate: string) => {
		if (!set.lengths.has(candidate.length)) return;
		const labels = set.digests.get(sha256(candidate));
		if (labels) for (const label of labels) names.add(label);
	};
	for (const token of text.split(TOKEN_SPLIT)) {
		if (token.length < MIN_SECRET_LENGTH) continue;
		for (const candidate of candidates(token)) check(candidate);
	}
	// Values with spaces or quotes: whole line, and an assignment's unquoted right side.
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length < MIN_SECRET_LENGTH) continue;
		check(line);
		const eq = line.indexOf("=");
		if (eq > 0) check(line.slice(eq + 1).trim().replace(/^(["'])(.*)\1;?$/, "$2"));
	}
	return [...names].sort();
}

const flagTable = (words: string[]): Record<string, true> => Object.fromEntries(words.map(word => [word, true]));
const SKIP_DIRS = flagTable([".git", "node_modules", "__pycache__", "site-packages", ".venv", "venv", "sessions", "logs", "file-history", "cache", "caches", "Cache", "CachedData", ".cache"]);
const SKIP_EXT = flagTable([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".pdf", ".zip", ".gz", ".tgz", ".xz", ".zst", ".bz2", ".7z", ".tar", ".dmg", ".wasm", ".dylib", ".so", ".node", ".o", ".a", ".mp3", ".mp4", ".mov", ".wav", ".m4a", ".gguf", ".safetensors", ".bin", ".pt", ".onnx", ".npy", ".parquet", ".sqlite", ".sqlite3", ".db", ".db-wal", ".db-shm", ".woff", ".woff2", ".ttf", ".otf", ".car", ".jar", ".class", ".pyc"]);

/** The contract's bounded roots; `.claude/projects` is excluded by path (it is the session store there). */
export function defaultSecretRoots(home: string): string[] {
	// Smallest, highest-value roots first: a cap hit in the bulk of ~/.local/share must not starve the rc files.
	return [".zshrc", ".zshenv", ".zprofile", "Library/LaunchAgents", ".config", ".local/bin", ".codex", ".claude", ".omp", ".local/share"].map(item => join(home, item));
}
function excludedDir(path: string, name: string, home: string): boolean {
	if (SKIP_DIRS[name] === true) return true;
	return path === join(home, ".claude", "projects");
}

interface ScanState { set: DigestSet; hits: SecretHit[]; files: number; bytes: number; skippedLarge: number; truncated: boolean }

function looksBinary(buffer: Buffer): boolean {
	const end = Math.min(buffer.length, 8192);
	for (let i = 0; i < end; i++) if (buffer[i] === 0) return true;
	return false;
}

function scanText(state: ScanState, label: string, buffer: Buffer): void {
	state.files += 1;
	state.bytes += buffer.length;
	if (looksBinary(buffer)) return;
	const names = findSecretNames(buffer.toString("utf8"), state.set);
	if (names.length) state.hits.push({ path: label, names });
}

function readCapped(path: string, size: number): Buffer {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(size);
		const n = readSync(fd, buffer, 0, size, 0);
		return buffer.subarray(0, n);
	} finally { closeSync(fd); }
}

function scanPath(state: ScanState, path: string, home: string): void {
	const stack = [path];
	while (stack.length) {
		const current = stack.pop() as string;
		let stat: Stats;
		try { stat = lstatSync(current); } catch { continue; }
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			if (current !== path && excludedDir(current, basename(current), home)) continue;
			let entries: string[];
			try { entries = readdirSync(current); } catch { continue; }
			for (const entry of entries.sort().reverse()) stack.push(join(current, entry));
			continue;
		}
		if (!stat.isFile() || SKIP_EXT[extname(current).toLowerCase()] === true) continue;
		if (stat.size > MAX_FILE_BYTES) { state.skippedLarge += 1; continue; }
		if (state.files >= MAX_FILES || state.bytes + stat.size > MAX_TOTAL_BYTES) { state.truncated = true; return; }
		try { scanText(state, current, readCapped(current, stat.size)); } catch { /* Unreadable file: not scanned, not counted. */ }
	}
}

function gitTrackedFiles(repo: string): string[] {
	const result = spawnSync("git", ["-C", repo, "ls-files", "-z"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1_048_576 });
	if (result.status !== 0) return [];
	return String(result.stdout).split("\0").filter(Boolean).map(file => join(repo, file));
}

/** A name is secret-shaped when one `_` component is a credential noun and none marks a pointer to it. */
const SECRET_PART = flagTable(["KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASS", "PAT", "CREDENTIAL", "CREDENTIALS", "PRIVATE"]);
const POINTER_PART = flagTable(["ID", "PATH", "FILE", "NAME", "URL", "DIR", "TTL", "TYPE", "EXPIRY", "ENDPOINT", "HOST", "PORT", "USER", "USERNAME", "REF", "SERVICE"]);
export function secretShapedName(name: string): boolean {
	const parts = name.toUpperCase().split("_");
	return parts.some(part => SECRET_PART[part] === true) && !parts.some(part => POINTER_PART[part] === true);
}

const LOWERCASE_HYPHEN_SLUG = /^[a-z]+(?:-[a-z]+)*$/;
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/:@]{1,200}:[^\s@]{1,500}@/i;

/** Omit public client keys and provider slugs; service-role keys remain credentials. */
export function addSecretValueToDigestSet(set: DigestSet, name: string, value: string, label: string): void {
	const normalizedName = name.toUpperCase();
	const isPublicKeyName = normalizedName.endsWith("_ANON_KEY")
		|| normalizedName.endsWith("_PUBLISHABLE_KEY")
		|| normalizedName.startsWith("NEXT_PUBLIC_")
		|| normalizedName.startsWith("EXPO_PUBLIC_");
	if (isPublicKeyName) return;
	const isProviderSlug = normalizedName.endsWith("_PROVIDER_CONFIG_KEY") && LOWERCASE_HYPHEN_SLUG.test(value.trim());
	const isServiceRoleKey = normalizedName === "SERVICE_ROLE_KEY" || normalizedName.endsWith("_SERVICE_ROLE_KEY");
	const isCredentialUrl = URL_WITH_CREDENTIALS.test(value);
	if ((!isProviderSlug && (secretShapedName(name) || isServiceRoleKey)) || isCredentialUrl) addValue(set, value, label);
}

/** `tmux show-environment -g` lines: NAME=value or -NAME (removed). Returns the offending NAMEs only. */
export function tmuxSecretNames(showEnvironment: string, set: DigestSet | null): string[] {
	const names = new Set<string>();
	for (const line of showEnvironment.split("\n")) {
		const eq = line.indexOf("=");
		if (eq <= 0 || line.startsWith("-")) continue;
		const name = line.slice(0, eq);
		const value = line.slice(eq + 1);
		if (value === "") continue;
		if (secretShapedName(name)) names.add(name);
		else if (set && set.lengths.has(value.length) && set.digests.has(sha256(value))) names.add(name);
	}
	return [...names].sort();
}

function readTmuxEnvironment(): string {
	const result = spawnSync("tmux", ["show-environment", "-g"], { encoding: "utf8", timeout: 5_000 });
	return result.status === 0 ? String(result.stdout) : "";
}

/**
 * NOAMBIENT1 guard (ompkit-3h11): secrets MUST NOT live in the shell/tmux environment.
 * Mirrors ~/.config/zsh/99-no-ambient-secrets.zsh. The allowlist is empty by operator
 * decision (2026-10-11: Agent Mail runs --no-auth on loopback); entries need a named
 * consumer and Josh's review. All outputs are NAMES only, never values.
 */
export const NO_AMBIENT_ALLOWLIST: ReadonlySet<string> = new Set();

/** Shell rc files the guard covers. Injectable via input.rcFiles (scratch files in tests). */
export function defaultNoAmbientRcFiles(home: string): string[] {
	const files = [join(home, ".zshenv"), join(home, ".zshrc"), join(home, ".zprofile")];
	let dir: string[] = [];
	try { dir = readdirSync(join(home, ".config", "zsh")); } catch { /* absent */ }
	for (const entry of dir.sort()) if (entry.endsWith(".zsh")) files.push(join(home, ".config", "zsh", entry));
	return files;
}

const PLACEHOLDER_VALUE = /^(?:xxx+|changeme|placeholder|example|test|sample|redacted|<[^>]*>)$/i;
const DYNAMIC_VALUE = /^\s*(?:\$|`|\$\()/;
const LIVE_FETCH_REF = /cf-secret|inf_export_live|infisical/i;

/** The zsh guard's `case` globs, exactly (case-sensitive): `*X*` contains, `*X` ends with. */
const NO_AMBIENT_CONTAINS = ["SECRET", "PASSWORD", "PASSWD", "PRIVATE_KEY", "API_KEY", "ACCESS_KEY", "CLIENT_SECRET", "DATABASE_URL", "BEARER"] as const;
const NO_AMBIENT_SUFFIX = ["_TOKEN", "_DSN", "_APP_ID"] as const;

/** Would ~/.config/zsh/99-no-ambient-secrets.zsh strip this exported name? Same globs, so the doctor never FAILs on a name the guard allows (e.g. TERN_WINDOW_KEY). */
export function noAmbientSecretName(name: string): boolean {
	return NO_AMBIENT_CONTAINS.some(part => name.includes(part)) || NO_AMBIENT_SUFFIX.some(suffix => name.endsWith(suffix));
}

/** Is this right-hand side a literal secret value (not a reference, fetch, or placeholder)? */
export function rcLiteralValue(value: string): boolean {
	let text = value.trim();
	if (!text) return false;
	if (text.endsWith(";")) text = text.slice(0, -1).trim();
	const quoted = text.match(/^(['"])(.*)\1\s*$/) ?? text.match(/^(['"])(.*)$/);
	if (quoted) text = (quoted[2] as string).trim();
	if (!text || DYNAMIC_VALUE.test(text) || LIVE_FETCH_REF.test(text) || PLACEHOLDER_VALUE.test(text)) return false;
	return text.length >= 8;
}

/** Secret-shaped NAMES with literal values in rc-file text. Returns NAMES only, never values. */
export function rcLiteralSecretNames(text: string, allowlist: ReadonlySet<string> = NO_AMBIENT_ALLOWLIST): string[] {
	const names = new Set<string>();
	for (const line of text.split("\n")) {
		if (line.length > 4096) continue; // bound per-line match work; rc assignments are short
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\+?=\s*(.+?)\s*$/);
		if (!match) continue;
		const name = match[1] as string;
		if (allowlist.has(name) || !noAmbientSecretName(name)) continue;
		if (rcLiteralValue(match[2] as string)) names.add(name);
	}
	return [...names].sort();
}

/** Scan rc files for literal secret-shaped exports. Missing/unreadable files stay quiet. */
export function scanNoAmbientRcFiles(files: string[], allowlist: ReadonlySet<string> = NO_AMBIENT_ALLOWLIST): RcSecretHit[] {
	const hits: RcSecretHit[] = [];
	for (const file of files) {
		let text: string;
		try {
			const stat = lstatSync(file);
			if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
			text = readFileSync(file, "utf8");
		} catch { continue; }
		const names = rcLiteralSecretNames(text, allowlist);
		if (names.length) hits.push({ path: file, names });
	}
	return hits;
}

/** Non-allowlisted secret-shaped NAMES present in the given environment NAMES. Names only. */
export function liveProcessSecretNames(envNames: Iterable<string>, allowlist: ReadonlySet<string> = NO_AMBIENT_ALLOWLIST): string[] {
	const names: string[] = [];
	for (const name of envNames) {
		if (!allowlist.has(name) && noAmbientSecretName(name)) names.push(name);
	}
	return names.sort();
}

/** Count local omp processes (respawn candidates): processes whose argv[0] basename is exactly `omp`. Counts only; never reads environments. */
export function countLocalOmpProcesses(): number | null {
	try {
		const result = spawnSync("ps", ["-axo", "args="], { encoding: "utf8", timeout: 5_000 });
		if (result.status !== 0) return null;
		return ompArgvCount(String(result.stdout));
	} catch { return null; }
}

/** Lines of `ps -axo args=` whose first word's basename is exactly `omp`. */
export function ompArgvCount(psArgs: string): number {
	return psArgs.split("\n").filter(line => {
		const argv0 = line.trim().split(/\s+/, 1)[0] ?? "";
		return argv0 !== "" && argv0.slice(argv0.lastIndexOf("/") + 1) === "omp";
	}).length;
}

export interface SecretsScanInput {
	home?: string;
	/** Paths scanned recursively (files or directories). */
	roots?: string[];
	/** Repositories whose git-tracked files are scanned. */
	repos?: string[];
	digests?: () => DigestResult;
	tmuxEnvironment?: () => string;
	/** Staged-blob mode: scan the index of this repository only (the pre-commit hook). */
	stagedRepo?: string;
	/** Rc files for the no-ambient guard; defaults to defaultNoAmbientRcFiles(home). */
	rcFiles?: string[];
	/** Extra allowlist entries (reviewed names); defaults to NO_AMBIENT_ALLOWLIST (empty). */
	allowlist?: ReadonlySet<string>;
	/** Environment NAMES for the live-process check; defaults to Object.keys(process.env). */
	processEnvNames?: () => Iterable<string>;
	/** Local omp process count; defaults to countLocalOmpProcesses(). */
	processCount?: () => number | null;
}

function stagedBlobs(state: ScanState, repo: string): void {
	const list = spawnSync("git", ["-C", repo, "diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1_048_576 });
	if (list.status !== 0) throw new Error(`git diff --cached failed in ${repo}`);
	for (const file of String(list.stdout).split("\0").filter(Boolean)) {
		if (SKIP_EXT[extname(file).toLowerCase()] === true) continue;
		const size = spawnSync("git", ["-C", repo, "cat-file", "-s", `:${file}`], { encoding: "utf8", timeout: 10_000 });
		if (size.status !== 0) continue;
		if (Number(String(size.stdout).trim()) > MAX_FILE_BYTES) { state.skippedLarge += 1; continue; }
		const blob = spawnSync("git", ["-C", repo, "cat-file", "blob", `:${file}`], { timeout: 10_000, maxBuffer: MAX_FILE_BYTES + 1 });
		if (blob.status === 0) scanText(state, file, Buffer.from(blob.stdout));
	}
}

export function inspectSecrets(input: SecretsScanInput = {}): SecretsReport {
	const home = resolve(input.home ?? process.env.HOME ?? "");
	const staged = input.stagedRepo !== undefined;
	const roots = staged ? [resolve(input.stagedRepo as string)] : [...(input.roots ?? defaultSecretRoots(home)), ...(input.repos ?? []).map(repo => resolve(repo))];
	const result = (input.digests ?? (() => liveDigestSource(home)))();
	const allowlist = input.allowlist ?? NO_AMBIENT_ALLOWLIST;
	const noAmbient = (): Pick<SecretsReport, "rc_secret_hits" | "live_process_secret_names" | "live_process_count"> => {
		if (staged) return { rc_secret_hits: [], live_process_secret_names: [], live_process_count: null };
		const rcFiles = input.rcFiles ?? defaultNoAmbientRcFiles(home);
		return {
			rc_secret_hits: scanNoAmbientRcFiles(rcFiles, allowlist).map(hit => ({ path: hit.path.startsWith(home + "/") ? `~/${relative(home, hit.path)}` : hit.path, names: hit.names })),
			live_process_secret_names: liveProcessSecretNames((input.processEnvNames ?? (() => Object.keys(process.env)))(), allowlist),
			live_process_count: (input.processCount ?? countLocalOmpProcesses)(),
		};
	};
	const base = { scope: "secrets" as const, mode: staged ? "staged" as const : "roots" as const, roots, tmux_secret_names: [] as string[], rc_secret_hits: [] as RcSecretHit[], live_process_secret_names: [] as string[], live_process_count: null as number | null, files_scanned: 0, bytes_scanned: 0, skipped_large: 0, truncated: false };
	if (result.status === "UNREACHABLE") {
		const tmux = staged ? [] : tmuxSecretNames((input.tmuxEnvironment ?? readTmuxEnvironment)(), null);
		const guard = noAmbient();
		const failing = tmux.length > 0 || guard.rc_secret_hits.length > 0 || guard.live_process_secret_names.length > 0;
		const overall = failing ? "FAIL" : "UNVERIFIED";
		const text = `${overall}: Infisical unreachable (${result.reason}); the digest scan did not run, so no PASS.${tmux.length ? ` Secret-shaped names in the tmux global environment: ${tmux.join(", ")}.` : ""}${guard.rc_secret_hits.length ? ` Literal secret-shaped exports in rc files: ${guard.rc_secret_hits.map(hit => `${hit.path}: ${hit.names.join(", ")}`).join("; ")}.` : ""}${guard.live_process_secret_names.length ? ` Secret-shaped names in the live process environment: ${guard.live_process_secret_names.join(", ")} (${guard.live_process_count ?? "unknown"} local omp process(es) still run on a pre-guard environment until respawned).` : ""}`;
		return { ...base, overall, digest_source: "infisical", vault_projects: 0, vault_digests: 0, failed_vault_reads: [], hits: [], tmux_secret_names: tmux, ...guard, reason: result.reason, text };
	}
	const state: ScanState = { set: result.set, hits: [], files: 0, bytes: 0, skippedLarge: 0, truncated: false };
	if (staged) stagedBlobs(state, roots[0] as string);
	else {
		for (const root of input.roots ?? defaultSecretRoots(home)) scanPath(state, root, home);
		for (const repo of input.repos ?? []) for (const file of gitTrackedFiles(resolve(repo))) {
			let size: number;
			try { const stat = lstatSync(file); if (!stat.isFile()) continue; size = stat.size; } catch { continue; }
			if (SKIP_EXT[extname(file).toLowerCase()] === true) continue;
			if (size > MAX_FILE_BYTES) { state.skippedLarge += 1; continue; }
			if (state.files >= MAX_FILES) { state.truncated = true; break; }
			try { scanText(state, file, readCapped(file, size)); } catch { /* unreadable */ }
		}
	}
	const tmux = staged ? [] : tmuxSecretNames((input.tmuxEnvironment ?? readTmuxEnvironment)(), result.set);
	const guard = noAmbient();
	const failing = state.hits.length > 0 || tmux.length > 0 || guard.rc_secret_hits.length > 0 || guard.live_process_secret_names.length > 0;
	const overall = failing ? "FAIL" : state.truncated || result.set.failed.length ? "UNVERIFIED" : "PASS";
	const reason = [state.truncated ? `scan truncated at ${MAX_FILES} files or ${MAX_TOTAL_BYTES} bytes; later files were not scanned` : "", result.set.failed.length ? `vault projects unread: ${result.set.failed.join(", ")}` : ""].filter(Boolean).join("; ") || null;
	const shown = (path: string) => staged ? path : path.startsWith(home + "/") ? `~/${relative(home, path)}` : path;
	const lines = [
		`${overall}: ${state.hits.length} file(s) hold a vault value; ${tmux.length} secret-shaped tmux global name(s); ${guard.rc_secret_hits.length} rc file(s) with literal secret-shaped exports; ${guard.live_process_secret_names.length} secret-shaped live process name(s). Scanned ${state.files} file(s), ${state.bytes} byte(s), against ${result.set.digests.size} digest(s) from ${result.set.source}${result.set.projects ? ` (${result.set.projects} project(s))` : ""}.`,
		...state.hits.map(hit => `  ${shown(hit.path)}: ${hit.names.join(", ")}`),
		...(tmux.length ? [`  tmux show-environment -g: ${tmux.join(", ")}`] : []),
		...guard.rc_secret_hits.map(hit => `  rc ${shown(hit.path)}: ${hit.names.join(", ")}`),
		...(guard.live_process_secret_names.length ? [`  live process environment: ${guard.live_process_secret_names.join(", ")} (${guard.live_process_count ?? "unknown"} local omp process(es) still run on a pre-guard environment until respawned from a fresh shell)`] : []),
		...(state.skippedLarge ? [`  skipped ${state.skippedLarge} file(s) over ${MAX_FILE_BYTES} bytes`] : []),
		...(reason ? [`  ${reason}`] : []),
		...(failing ? ["  Remove each value from the file (source it with cf-secret NAME / inf_export_live at point of use) and rotate it in Infisical."] : []),
	];
	return { ...base, overall, digest_source: result.set.source, vault_projects: result.set.projects, vault_digests: result.set.digests.size, failed_vault_reads: result.set.failed, hits: state.hits.map(hit => ({ path: shown(hit.path), names: hit.names })), tmux_secret_names: tmux, ...guard, files_scanned: state.files, bytes_scanned: state.bytes, skipped_large: state.skippedLarge, truncated: state.truncated, reason, text: lines.join("\n") };
}

/** CLI wiring: seams are env-only so the pre-commit hook and the planted tests drive the real binary. */
export function secretsScanInputFromEnv(env: NodeJS.ProcessEnv, flags: { root?: string; staged?: boolean; cwd: string }): SecretsScanInput {
	const input: SecretsScanInput = {};
	if (env.OMP_KIT_SECRET_SCAN_UNREACHABLE === "1") input.digests = () => ({ status: "UNREACHABLE", reason: "forced by OMP_KIT_SECRET_SCAN_UNREACHABLE" });
	else if (env.OMP_KIT_SECRET_DIGESTS_FILE) { const path = env.OMP_KIT_SECRET_DIGESTS_FILE; input.digests = () => ({ status: "OK", set: digestSetFromFile(path) }); }
	if (env.OMP_KIT_SECRET_SCAN_ROOTS) input.roots = env.OMP_KIT_SECRET_SCAN_ROOTS.split(delimiter).filter(Boolean);
	if (env.OMP_KIT_SECRET_SCAN_TMUX_ENV !== undefined) { const text = env.OMP_KIT_SECRET_SCAN_TMUX_ENV; input.tmuxEnvironment = () => text; }
	if (env.OMP_KIT_SECRET_SCAN_RC_FILES !== undefined) { const files = env.OMP_KIT_SECRET_SCAN_RC_FILES.split(delimiter).filter(Boolean); input.rcFiles = files; }
	if (env.OMP_KIT_SECRET_SCAN_ALLOWLIST !== undefined) { const extra = new Set(env.OMP_KIT_SECRET_SCAN_ALLOWLIST.split(delimiter).filter(Boolean)); input.allowlist = extra; }
	if (env.OMP_KIT_SECRET_SCAN_PROCESS_ENV !== undefined) { const names = env.OMP_KIT_SECRET_SCAN_PROCESS_ENV.split(delimiter).filter(Boolean); input.processEnvNames = () => names; }
	if (env.OMP_KIT_SECRET_SCAN_PROCESS_COUNT !== undefined) { const parsed = env.OMP_KIT_SECRET_SCAN_PROCESS_COUNT === "" ? null : Number(env.OMP_KIT_SECRET_SCAN_PROCESS_COUNT); const count = parsed === null || Number.isSafeInteger(parsed) ? parsed : null; input.processCount = () => count; }
	const repos = flags.root ?? env.OMP_KIT_SECRET_SCAN_REPOS;
	if (repos) input.repos = repos.split(delimiter).filter(Boolean);
	if (flags.staged) input.stagedRepo = flags.cwd;
	return input;
}
