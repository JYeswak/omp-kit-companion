import { redactBindingFields, scrubText, REDACTED, REPLAY_GENERIC_ASSIGNMENT, REPLAY_SECRET_FLAGS } from "../extensions/secret-output-guard.ts";
import catalog from "./cc-credential-shapes.v1.json";
import { createCcCredentialScreen } from "./cc-credentials.ts";

export interface MineReplay {
	version: 1;
	tool: string | null;
	arguments: unknown | null;
	cwd: string | null;
	staged_paths: string[] | null;
	diff_sha256: string | null;
	message: string | null;
	custody: unknown | null;
	redacted: boolean;
	truncated: boolean;
	missing: string[];
}

interface ReplayInput {
	tool?: string;
	arguments?: unknown;
	cwd?: string;
	staged_paths?: readonly string[];
	diff_sha256?: string;
	message?: string;
	custody?: unknown;
}
const screen = createCcCredentialScreen(catalog);
const SHORT_SECRET_FLAGS = [...REPLAY_SECRET_FLAGS].filter(flag => flag.length === 2 && flag[1] !== "-");
const FIELDS = ["tool", "arguments", "cwd", "staged_paths", "diff_sha256", "message", "custody"] as const;
const MAX_BYTES = 32 * 1024;

/** Scrub full leaves before bounding; omitted structure is explicitly not an exact replay. */
export function captureMineReplay(input: ReplayInput): MineReplay {
	let redacted = false;
	let truncated = false;
	let nodes = 0;
	const seen = new Set<object>();
	function text(raw: string, key = ""): string {
		if (raw.length > 8192) truncated = true;
		const binding = redactBindingFields({ [key]: raw }) as Record<string, unknown>;
		const assigned = raw.replace(REPLAY_GENERIC_ASSIGNMENT, "$1<redacted>");
		const keyed = key !== "" && assigned === raw && `${key}=${raw}`.replace(REPLAY_GENERIC_ASSIGNMENT, "$1<redacted>") !== `${key}=${raw}`;
		const clean = binding[key] === REDACTED || screen(raw) !== null || (key !== "" && screen(`${key}=${raw}`) !== null) || keyed
			? REDACTED : scrubText(assigned);
		if (clean !== raw) redacted = true;
		if (clean.length > 8192) truncated = true;
		return clean.slice(0, 8192);
	}
	function visit(value: unknown, depth = 0, key = ""): unknown {
		if (++nodes > 1024 || depth > 8) { truncated = true; return null; }
		if (typeof value === "string") return text(value, key);
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value !== "object") { truncated = true; return null; }
		if (seen.has(value)) { truncated = true; return null; }
		seen.add(value);
		try {
			if (Array.isArray(value)) {
				if (value.length > 128) truncated = true;
				let hideNext = false;
				return value.slice(0, 128).map(entry => {
					if (hideNext) {
						hideNext = false;
						redacted = true;
						if (typeof entry === "string" && entry.length > 8192) truncated = true;
						return REDACTED;
					}
					if (typeof entry === "string") {
						if (REPLAY_SECRET_FLAGS.has(entry)) hideNext = true;
						else {
							const equals = entry.indexOf("=");
							const flag = equals > 0 && REPLAY_SECRET_FLAGS.has(entry.slice(0, equals))
								? entry.slice(0, equals) : SHORT_SECRET_FLAGS.find(flag => entry.length > flag.length && entry.startsWith(flag));
							if (flag) {
								redacted = true;
								if (entry.length > 8192) truncated = true;
								return `${flag}${equals === flag.length ? "=" : ""}${REDACTED}`;
							}
						}
					}
					return visit(entry, depth + 1);
				});
			}
			const out: Record<string, unknown> = Object.create(null);
			let count = 0;
			for (const original of Object.keys(value)) {
				if (++count > 128) { truncated = true; break; }
				const descriptor = Object.getOwnPropertyDescriptor(value, original);
				if (!descriptor || !("value" in descriptor)) { truncated = true; continue; }
				const name = text(original).slice(0, 256);
				if (name.length !== original.length) truncated = true;
				out[name] = visit(descriptor.value, depth + 1, original);
			}
			return out;
		} finally { seen.delete(value); }
	}
	const paths = input.staged_paths === undefined ? null : visit(input.staged_paths);
	const replay: MineReplay = {
		version: 1,
		tool: typeof input.tool === "string" ? text(input.tool) : null,
		arguments: input.arguments === undefined || input.arguments === null ? null : visit(input.arguments),
		cwd: typeof input.cwd === "string" ? text(input.cwd) : null,
		staged_paths: Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : null,
		diff_sha256: typeof input.diff_sha256 === "string" ? text(input.diff_sha256) : null,
		message: typeof input.message === "string" ? text(input.message) : null,
		custody: input.custody === undefined || input.custody === null ? null : visit(input.custody),
		redacted: false, truncated: false, missing: [],
	};
	replay.redacted = redacted;
	replay.truncated = truncated;
	replay.missing = FIELDS.filter(key => replay[key] === null);
	// Escapes and multi-byte strings count too. Keep small ordinary arguments when another field is huge.
	while (Buffer.byteLength(JSON.stringify(replay), "utf8") > MAX_BYTES) {
		const largest = [...FIELDS].sort((a, b) => JSON.stringify(replay[b]).length - JSON.stringify(replay[a]).length)[0]!;
		replay[largest] = null;
		if (!replay.missing.includes(largest)) replay.missing.push(largest);
		replay.truncated = true;
	}
	return replay;
}

/** Disk is untrusted: validate shape, scrub again, and never erase prior loss flags. */
export function readMineReplay(value: unknown): MineReplay | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	try {
		const row = value as Record<string, unknown>;
		if (row.version !== 1 || typeof row.redacted !== "boolean" || typeof row.truncated !== "boolean" || !Array.isArray(row.missing) || !row.missing.every(item => typeof item === "string")) return null;
		for (const key of FIELDS) if (!Object.hasOwn(row, key)) return null;
		for (const key of ["tool", "cwd", "diff_sha256", "message"]) if (row[key] !== null && typeof row[key] !== "string") return null;
		if (row.staged_paths !== null && (!Array.isArray(row.staged_paths) || !row.staged_paths.every(item => typeof item === "string"))) return null;
		const replay = captureMineReplay({
			...(typeof row.tool === "string" ? { tool: row.tool } : {}), arguments: row.arguments,
			...(typeof row.cwd === "string" ? { cwd: row.cwd } : {}),
			...(Array.isArray(row.staged_paths) ? { staged_paths: row.staged_paths as string[] } : {}),
			...(typeof row.diff_sha256 === "string" ? { diff_sha256: row.diff_sha256 } : {}),
			...(typeof row.message === "string" ? { message: row.message } : {}), custody: row.custody,
		});
		replay.redacted ||= row.redacted;
		replay.truncated ||= row.truncated;
		// Missing names are schema field names, not arbitrary attacker-controlled text.
		replay.missing = [...new Set([...replay.missing, ...row.missing.filter(item => FIELDS.includes(item as typeof FIELDS[number]))])];
		return replay;
	} catch { return null; }
}
