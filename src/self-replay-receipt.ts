import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicReplaceBytes } from "./kitlib/io.ts";
import { resolveVerifyStateRoot } from "./verify-ledger.ts";

// SELFREPLAYGATE1 (ompkit-gh3sj): `omp-kit verify BEAD --export SHA --self-replay` leaves one receipt per bead under the kit state dir;
// the flywheel guard reads it at `br update BEAD --status in_review` and never runs a replay itself.

export const SELF_REPLAY_RECEIPT_SCHEMA = 1;
const BEAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SelfReplayReceiptBox {
	index: number;
	phase: string | null;
	command: string | null;
	verdict: "PASS" | "FAIL" | "PENDING";
	output_sha256: string | null;
}

export interface SelfReplayReceipt {
	schema: typeof SELF_REPLAY_RECEIPT_SCHEMA;
	bead: string;
	export: string;
	acceptance_sha256: string;
	actor: string;
	time: string;
	boxes: SelfReplayReceiptBox[];
}

export const sha256Hex = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export interface ParsedBox { index: number; letter: string | null; phase: string | null; body: string }

/**
 * The digest a receipt binds: the parsed (letter, phase, body) of every tagged box, never the raw text, so ticking boxes
 * (`- [ ]` to `- [x]`) after the replay leaves it unchanged while any edit to a box's tag or body changes it.
 */
export function acceptanceDigest(boxes: readonly ParsedBox[]): string {
	return sha256Hex(JSON.stringify(boxes.map(box => [box.letter, box.phase, box.body])));
}

/** `<kit state>/self-replay/<bead>.json`, or null when the state root or bead id is unusable. */
export function receiptPath(env: Readonly<Record<string, string | undefined>>, bead: string): string | null {
	const root = resolveVerifyStateRoot(env);
	if (root === null || !BEAD_ID.test(bead)) return null;
	return join(root, "self-replay", `${bead}.json`);
}

/** Atomically replace the bead's receipt; returns the path, or null when it cannot be placed. */
export function writeReceipt(env: Readonly<Record<string, string | undefined>>, receipt: SelfReplayReceipt): string | null {
	const path = receiptPath(env, receipt.bead);
	if (path === null) return null;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	atomicReplaceBytes(path, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), { mode: 0o600, durability: "none" });
	return path;
}

function isBox(value: unknown): value is SelfReplayReceiptBox {
	if (value === null || typeof value !== "object") return false;
	const box = value as Record<string, unknown>;
	return Number.isInteger(box.index) && (box.verdict === "PASS" || box.verdict === "FAIL" || box.verdict === "PENDING")
		&& (box.phase === null || typeof box.phase === "string");
}

/** The receipt on disk, or null when absent, unreadable or not a schema-1 receipt. */
export function readReceipt(env: Readonly<Record<string, string | undefined>>, bead: string): SelfReplayReceipt | null {
	const path = receiptPath(env, bead);
	if (path === null) return null;
	try {
		const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (doc === null || typeof doc !== "object") return null;
		const r = doc as Record<string, unknown>;
		if (r.schema !== SELF_REPLAY_RECEIPT_SCHEMA || typeof r.bead !== "string" || typeof r.export !== "string" || typeof r.acceptance_sha256 !== "string"
			|| typeof r.actor !== "string" || typeof r.time !== "string" || !Array.isArray(r.boxes) || !r.boxes.every(isBox)) return null;
		return r as unknown as SelfReplayReceipt;
	} catch {
		return null;
	}
}

/** What a hand-over comment's DONE lines say about the commit: the shas they name, and the refs they name that are not shas. */
export interface DoneBinding { shas: string[]; refs: string[] }

const HEX = /^[0-9a-f]{7,64}$/;

/**
 * Only the DONE subject binds, as br-update-lint's `_handoff_source` reads it: on a line that is `DONE` or starts `DONE `, the first
 * word is `<repo>@<ref>` or a bare sha. Other hex-looking tokens (a parent commit, a digest, a file name) are explanation and never bind.
 * A ref after `@` that is not hex (`HEAD`, a branch, a substitution) is returned in `refs`; a DONE line with no `@` and no bare sha binds nothing.
 */
export function doneBinding(comment: string | null): DoneBinding {
	const out: DoneBinding = { shas: [], refs: [] };
	if (comment === null) return out;
	for (const raw of comment.split("\n")) {
		const line = raw.trim();
		if (line !== "DONE" && !line.startsWith("DONE ")) continue;
		const word = line.slice(4).trim().split(/\s+/)[0] ?? "";
		const at = word.indexOf("@");
		const ref = (at < 0 ? word : word.slice(at + 1)).split(":")[0]!.replace(/[,.;]+$/, "");
		if (HEX.test(ref.toLowerCase())) out.shas.push(ref.toLowerCase());
		else if (at >= 0) out.refs.push(ref === "" ? word : ref);
	}
	return out;
}

export type SelfReplayCheck = { refusal: string } | { receipt: SelfReplayReceipt | null };

/**
 * Whether `bead` may move to in_review: a refusal, or the receipt that admits it (null when no box needs one). A [build]/[landed]
 * (or unphased) box needs a PASS verdict in the receipt; [live]/[after] boxes and [v] judgements are exempt, and a bead with no
 * such boxes needs no receipt (nor a usable state dir). `commandFor` builds the exact self-replay command the refusals name, with the receipt's own export sha once one is known.
 */
export function selfReplayCheck(env: Readonly<Record<string, string | undefined>>, bead: string, assignee: string | null, acceptance: string, parse: (acceptance: string) => ParsedBox[], commandFor: (sha: string | null) => string, done: DoneBinding): SelfReplayCheck {
	let command = commandFor(null);
	const boxes = parse(acceptance);
	const required = boxes.filter(box => box.letter !== "v" && box.phase !== "live" && box.phase !== "after");
	if (required.length === 0) return { receipt: null };
	if (receiptPath(env, bead) === null) return { refusal: `no usable kit state dir to read ${bead}'s self-replay receipt from; set HOME or an absolute XDG_STATE_HOME, then run \`${command}\`.` };
	const receipt = readReceipt(env, bead);
	if (receipt === null) return { refusal: `${bead} has no self-replay receipt; run \`${command}\` as ${assignee ?? "the assignee"} on the published export, fix any failing box, then hand over.` };
	if (receipt.bead !== bead) return { refusal: `the self-replay receipt names ${receipt.bead}, not ${bead}; run \`${command}\`.` };
	command = commandFor(receipt.export);
	if (assignee === null || receipt.actor.trim().toLowerCase() !== assignee.trim().toLowerCase()) return { refusal: `the self-replay receipt is by ${receipt.actor}, but ${assignee ?? "nobody"} is ${bead}'s assignee; the assignee runs \`${command}\`.` };
	if (receipt.acceptance_sha256 !== acceptanceDigest(boxes)) return { refusal: `${bead}'s acceptance boxes changed after the self-replay receipt (${receipt.time}); run \`${command}\` again.` };
	const verdicts = new Map(receipt.boxes.map(box => [box.index, box.verdict]));
	const unmet = required.filter(box => verdicts.get(box.index) !== "PASS");
	if (unmet.length > 0) return { refusal: `the self-replay receipt of ${bead} (${receipt.time}) has no PASS for box index ${unmet.map(box => box.index).join(", ")}; fix them and run \`${command}\`.` };
	if (done.refs.length > 0) return { refusal: `the transition comment's DONE line names ${done.refs.join(", ")}, which is not a commit sha: name the exact sha you replayed (${receipt.export}).` };
	const stray = done.shas.filter(sha => !receipt.export.toLowerCase().startsWith(sha));
	if (stray.length > 0) return { refusal: `the transition comment's DONE line names ${stray.join(", ")}, but the self-replay receipt of ${bead} replayed export ${receipt.export}; name that commit or run \`${command}\` on the one you hand over.` };
	return { receipt };
}
