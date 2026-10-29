/** Memory-relevance filter, Phase 1 shadow (bead jev-s47b; design work/jev-7vn9-design.md).
 *
 * PORTABLE VENDOR (bead ompkit-ommaa): this file is vendored into the companion
 * from the lead-machine source it re-exported, with the two machine-absolute
 * private imports replaced by a self-contained local-Clef client below
 * (plain fetch to an explicit loopback Clef gateway, no hosted inference, no
 * key, no private checkout). Filter logic, calibration wire shape, and the
 * fail-safe threshold are vendored from the JEV repo (MIT Copyright (c) 2026
 * Joshua Nowak; this notice satisfies the license's attribution condition).
 * With HOME pointed at an empty dir the switch/log paths simply do not exist,
 * the enforce switch reads as off, and every memory is kept (the fail-safe
 * side). Scoring activates where JEV_CLEF_URL points at a loopback gateway
 * AND a committed calibration (JEV_CLEF_CALIBRATION_DIR) binds this exact
 * question + state keys with a matching model fingerprint
 * (JEV_CLEF_FINGERPRINT); otherwise the filter keeps everything and logs the
 * closed failure, exactly as before.
 *
 * On `before_agent_start` the handler parses `<memories>` and EE task-context
 * blocks out of the system prompt (event.systemPrompt, via ctx.getSystemPrompt
 * when present), scores each item against the user prompt with the
 * held-out-winning Noul (base wording, DROP iff noul < 0.5, invalid -> KEEP;
 * loss depth PASS 0.978, commit 9ff9f951), and logs keep/drop + tokens that
 * would be saved. Shadow by default: with the enforce switch absent the
 * handler always yields undefined and every memory is kept. When the enforce
 * switch file exists (and cap-3, for the mechanical top-3 cut), the handler
 * returns the pruned systemPrompt in a known session cwd and logs the
 * enforcement. Bounded per AGENTS.md: max 20 items/turn, daily call cap in
 * code, pause on repeated transport failure, fail safe (KEEP) on
 * invalid/timeout/throw. Gateway coordinates come from explicit
 * FilterDeps, else the environment (JEV_CLEF_URL, JEV_CLEF_CALIBRATION_DIR,
 * JEV_CLEF_FINGERPRINT, JEV_CLEF_TIMEOUT_MS) — supplied directly or via
 * `infisical run`, which is the portable form of the original Infisical
 * key-provider path.
 */
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
 import { dirname, join, sep } from "node:path";
 import { fileURLToPath } from "node:url";

export const CUT = 0.5;
export const MAX_ITEMS_PER_TURN = 20;
/** Cap-3 shipment (jev-8c09, pooled n=60 non-inferior): keep top-3 by system rank. */
export const CAP3_KEEP = 3;
export const MAX_DAILY_CALLS = 600;
export const CALL_TIMEOUT_MS = 15000;
export const TURN_BUDGET_MS = 45000;
export const PROMPT_CHARS = 2000;
const LOG_SCHEMA = "jev-memory-filter.v1";
const SIDECAR_SCHEMA = "jev-memory-filter-full.v1";
export const MAX_MEMO = 2000;

// One extension load serves one session process: rows stay attributable.
const INSTANCE = randomUUID().slice(0, 8);
const INSTANCE_STARTED_AT = new Date().toISOString();

function isCommitId(value: string): boolean {
  if (value.length !== 40 && value.length !== 64) return false;
  for (const char of value) {
    if (!"0123456789abcdef".includes(char)) return false;
  }
  return true;
}

 function loadedCommitForInstance(): string | null {
   const modulePath = fileURLToPath(import.meta.url);
   const parts = modulePath.split(sep);
   const pinIndex = parts.lastIndexOf("jev-pinned");
   const pinnedCommit = pinIndex < 0 ? undefined : parts[pinIndex + 1];
   if (pinnedCommit && isCommitId(pinnedCommit)) return pinnedCommit;
   // Portable vendor: no subprocess fallback. Extensions ship to profiles
   // without a checkout, and staged files must not spawn outside kitlib;
   // unknown provenance stays null (an allowed outcome downstream).
   return null;
 }

const LOADED_COMMIT = loadedCommitForInstance();

 /**
  * Portable local-Clef client: the filter's Noul scoring over plain fetch to
  * an explicit loopback Clef gateway (JEV_CLEF_URL), with no hosted inference,
  * no key, and no private imports. Wire and calibration semantics mirror
  * kit/src/clef.ts + kit/src/calibration.ts (MIT, see file header):
  * POST {url} JSON {model:"clef-flash", state, questions:{[question_key]:
  * {type:"noul", instructions}}}, response {answers, usage?, model?}.
  * Scoring requires an exact committed calibration (JEV_CLEF_CALIBRATION_DIR,
  * validated like loadCalibrations) whose question_sha256 binds this exact
  * question + state keys, plus a matching model fingerprint
  * (JEV_CLEF_FINGERPRINT JSON). Absent calibration, fingerprint mismatch, or
  * unconfigured URL all fail closed into the filter's fail-open KEEP path,
  * exactly like the original unconfigured-key behavior. The CLI convention
  * (classifier ask noul --backend clef) fixes the caller key to `value`; this
  * adapter maps scores.value to the filter's `rel` key and preserves the
  * 0.5 threshold and every fail-safe branch.
  */
 export const CLEF_MODEL_ID = "clef-flash";
 export const MODEL = CLEF_MODEL_ID;
 /** Default end-to-end deadline when JEV_CLEF_TIMEOUT_MS is unset. */
 export const CLEF_DEFAULT_TIMEOUT_MS = 10_000;
 /** Two consecutive failures hold the backend for this long (mirrors the
  * private client's Clef hold); the filter's own budgets bound each turn. */
 export const CLEF_BACKEND_HOLD_MS = 60_000;
 /** Conservative JSON byte cap approximating the token size preflight; the
  * gateway enforces the exact limit. Never rejects the filter's tiny states. */
 export const CLEF_REQUEST_BYTE_CAP = 262_144;
 export const TRUNCATION_LIMIT = 16_384;
 let clefConsecutiveFailures = 0;
 let clefHoldUntil = 0;

 /** Test seam: clear the backend hold. The live process keeps its hold. */
 export function resetClefBackendHold(): void {
   clefConsecutiveFailures = 0;
   clefHoldUntil = 0;
 }

 export type PlattMap = {
   kind: "platt-logit";
   target: "p_choice" | "noul";
   a: number;
   b: number;
   clip: number;
 };
 export type ClefCalibration = {
   schema: "jev.clef-calibration.v1";
   task_id: string;
   version: number;
   primitive: "choice" | "noul";
   question_key: string;
   question_sha256: string;
   model: {
     id: "clef-flash";
     joint_head_sha256: string;
     index_sha256: string;
   };
   map: PlattMap;
   fit: Record<string, unknown>;
   receipt: {
     prereg_commit: string;
     result_commit: string;
     verdict: "PASS";
     [key: string]: unknown;
   };
 };
 export type ModelFingerprint = Pick<ClefCalibration["model"], "joint_head_sha256" | "index_sha256">;
 export type ClefFailureReason = "uncalibrated" | "truncated" | "size-limit" | "backend-hold" | "online-required" | "refused-unsafe" | "http" | "non-json" | "no-answers" | "transport" | "aborted";
 export type JevUsage = {
   input_tokens: number;
   output_tokens: number;
   billing_units: number | null;
   extra: Record<string, number>;
 };
 export type JevResult =
   | { ok: true; scores: Record<string, number>; latencyMs: number; model: string; usage?: JevUsage }
   | { ok: false; reason: ClefFailureReason; error: string; latencyMs: number; model: string };

 export type AskOptions = {
   /** The object the questions are asked about. Serialised as-is into `state`. */
   state: Record<string, unknown>;
   /** key -> instructions, or a noul body with optional criteria. Keys come back as the score keys. */
   questions: Record<string, string | { instructions: string; criteria?: { true: string; false: string } }>;
   timeoutMs?: number;
   model?: string;
   apiKey?: string;
   /** Transport override for offline tests. Defaults to globalThis.fetch, read at call time. */
   fetchImpl?: typeof fetch;
   /** Wall clock in ms for the backend hold. Tests inject it. Defaults to Date.now. */
   nowMs?: () => number;
   /** Explicit loopback gateway URL; overrides JEV_CLEF_URL. */
   clefUrl?: string;
   /** Explicit calibration; overrides JEV_CLEF_CALIBRATION_DIR. */
   clefCalibration?: ClefCalibration;
   /** Explicit model fingerprint; overrides JEV_CLEF_FINGERPRINT. */
   clefFingerprint?: ModelFingerprint;
 };

 type Ask = (options: AskOptions) => Promise<JevResult>;

 function asRecord(value: unknown, label: string): Record<string, unknown> {
   if (!value || typeof value !== "object" || Array.isArray(value)) {
     throw new Error(`${label} must be an object`);
   }
   // Guarded above: non-null, non-array object.
   const record: Record<string, unknown> = value as Record<string, unknown>;
   return record;
 }

 function validateNoulAnswer(answer: unknown): number {
   const record = asRecord(answer, "noul answer");
   const noul = record.noul;
   if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
     throw new Error("noul must be finite and in [0,1]");
   }
   return noul;
 }

 /** Read `usage` field by field; never invent one. Absent without a finite pair. */
 function readUsage(raw: unknown): JevUsage | undefined {
   if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
   const finite = (key: string): number | null => {
     const value: unknown = Reflect.get(raw, key);
     return typeof value === "number" && Number.isFinite(value) ? value : null;
   };
   const input_tokens = finite("input_tokens");
   const output_tokens = finite("output_tokens");
   if (input_tokens === null || output_tokens === null) return undefined;
   const extra: Record<string, number> = {};
   for (const key of Object.keys(raw)) {
     if (key === "input_tokens" || key === "output_tokens" || key === "billing_units") continue;
     const value = finite(key);
     if (value !== null) extra[key] = value;
   }
   return { input_tokens, output_tokens, billing_units: finite("billing_units"), extra };
 }

 const HEX_DIGITS = "0123456789abcdef";
 function isSha256(value: unknown): value is string {
   return typeof value === "string" && value.length === 64 && [...value].every((char) => HEX_DIGITS.includes(char.toLowerCase()));
 }

 function stableValue(value: unknown): unknown {
   if (Array.isArray(value)) return value.map(stableValue);
   if (value !== null && typeof value === "object") {
     // Guarded above: non-null object; sort keys for a canonical hash.
     const object: Record<string, unknown> = value as Record<string, unknown>;
     return Object.fromEntries(Object.keys(object).sort().map((key) => [key, stableValue(object[key])]));
   }
   return value;
 }

 /** Hash the canonical question schema and the state keys it was calibrated against. */
 export function questionSha(question: unknown, stateKeys: readonly string[]): string {
   if (!Array.isArray(stateKeys) || stateKeys.length === 0 || !stateKeys.every((key) => typeof key === "string" && key.length > 0)) {
     throw new TypeError("stateKeys must be a non-empty list of strings");
   }
   if (question === undefined) throw new TypeError("question must be JSON-serializable");
   const body = JSON.stringify({ question: stableValue(question), state_keys: [...stateKeys].sort() });
   if (body === undefined) throw new TypeError("question must be JSON-serializable");
   return createHash("sha256").update(body, "utf8").digest("hex");
 }

 export function plattMap(probability: number, map: Pick<PlattMap, "a" | "b" | "clip">): number {
   if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
     throw new TypeError("probability must be finite and in [0,1]");
   }
   if (!Number.isFinite(map.a) || !Number.isFinite(map.b) || !Number.isFinite(map.clip) || map.clip <= 0 || map.clip >= 0.5) {
     throw new TypeError("Platt map must contain finite coefficients and a clip in (0,0.5)");
   }
   const p = Math.min(Math.max(probability, map.clip), 1 - map.clip);
   return 1 / (1 + Math.exp(-(map.a * Math.log(p / (1 - p)) + map.b)));
 }
 // Every `as Record` below follows an explicit non-null, non-array object guard.
 function validCalibration(value: unknown, filename: string): value is ClefCalibration {
   if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
   const candidate: Record<string, unknown> = value as Record<string, unknown>;
   if (candidate.schema !== "jev.clef-calibration.v1") return false;
   if (typeof candidate.task_id !== "string" || !candidate.task_id || !Number.isSafeInteger(candidate.version) || (candidate.version as number) < 1) return false;
   if (filename !== `${candidate.task_id}.v${candidate.version}.json`) return false;
   if (candidate.primitive !== "choice" && candidate.primitive !== "noul") return false;
   if (typeof candidate.question_key !== "string" || !candidate.question_key || !isSha256(candidate.question_sha256)) return false;
   if (candidate.model === null || typeof candidate.model !== "object" || Array.isArray(candidate.model)) return false;
   const model: Record<string, unknown> = candidate.model as Record<string, unknown>;
   if (model.id !== "clef-flash" || !isSha256(model.joint_head_sha256) || !isSha256(model.index_sha256)) return false;
   if (candidate.map === null || typeof candidate.map !== "object" || Array.isArray(candidate.map)) return false;
   const map: Record<string, unknown> = candidate.map as Record<string, unknown>;
   if (map.kind !== "platt-logit" || typeof map.a !== "number" || !Number.isFinite(map.a) || typeof map.b !== "number" || !Number.isFinite(map.b)) return false;
   if (typeof map.clip !== "number" || !Number.isFinite(map.clip) || map.clip <= 0 || map.clip >= 0.5) return false;
   if (candidate.primitive === "choice" && map.target !== "p_choice") return false;
   if (candidate.primitive === "noul" && map.target !== "noul") return false;
  if (candidate.fit === null || typeof candidate.fit !== "object" || Array.isArray(candidate.fit)) return false;
  if (candidate.receipt === null || typeof candidate.receipt !== "object" || Array.isArray(candidate.receipt)) return false;
  // Guarded above: non-null object.
  const receipt: Record<string, unknown> = candidate.receipt as Record<string, unknown>;
  if (receipt.verdict !== "PASS" || !isCommit(receipt.prereg_commit) || !isCommit(receipt.result_commit)) return false;
  return true;
 }

 function isCommit(value: unknown): value is string {
   return typeof value === "string" && value.length >= 7 && value.length <= 40 && [...value].every((char) => HEX_DIGITS.includes(char.toLowerCase()));
 }

 /** Load only structurally valid, versioned calibration files; malformed files and an absent directory fail closed. */
 export async function loadCalibrations(directory: string): Promise<ClefCalibration[]> {
   let names: string[];
   try {
     names = await readdir(directory);
   } catch (error) {
     if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
     throw error;
   }
   const calibrations: ClefCalibration[] = [];
   const seen = new Set<string>();
   for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
     let parsed: unknown;
     try {
       parsed = JSON.parse(await readFile(join(directory, name), "utf8"));
     } catch {
       continue;
     }
     if (!validCalibration(parsed, name) || seen.has(parsed.task_id)) continue;
     seen.add(parsed.task_id);
     calibrations.push(parsed);
   }
   return calibrations;
 }

 /** Loopback gate: http only, 127.0.0.1/localhost/::1, never port 8010, no userinfo. */
 export function clefEndpoint(value: string): URL | undefined {
   let url: URL;
   try {
     url = new URL(value);
   } catch {
     return undefined;
   }
   const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
   if (!loopback || url.protocol !== "http:" || url.port === "8010" || url.username || url.password) return undefined;
   return url;
 }

 function parseFingerprint(raw: string | undefined): ModelFingerprint | undefined {
   if (!raw) return undefined;
   let parsed: unknown;
   try {
     parsed = JSON.parse(raw);
   } catch {
     return undefined;
   }
   if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
   if (!("joint_head_sha256" in parsed) || !("index_sha256" in parsed)) return undefined;
   const joint = parsed.joint_head_sha256;
   const index = parsed.index_sha256;
   if (!isSha256(joint) || !isSha256(index)) return undefined;
   return { joint_head_sha256: joint, index_sha256: index };
 }

 function clefFailure(reason: ClefFailureReason, error: string, latencyMs: number, taskModel = CLEF_MODEL_ID): JevResult {
   return { ok: false, reason, error, latencyMs, model: taskModel };
 }

 /**
  * Noul scoring through the local Clef gateway, adapted to the filter's `rel`
  * key (the CLI fixes the caller key to `value`). Every unconfigured,
  * uncalibrated, or transport outcome returns ok:false so the handler keeps
  * the memory (fail-open), exactly like the original keyless path.
  */
 export async function askClefNoul(options: AskOptions): Promise<JevResult> {
   const nowMs = options.nowMs ?? Date.now;
   const started = Date.now();
   if (nowMs() < clefHoldUntil) {
     return clefFailure("backend-hold", `Clef backend hold until=${new Date(clefHoldUntil).toISOString()}`, 0);
   }
  // Mirrors recordClefFailure: only transport failures implicate the gateway;
  // every other outcome resets the streak.
  const noteFailure = (result: JevResult): JevResult => {
    if (!result.ok && result.reason === "transport") {
      clefConsecutiveFailures += 1;
      if (clefConsecutiveFailures >= 2) clefHoldUntil = nowMs() + CLEF_BACKEND_HOLD_MS;
    } else {
      clefConsecutiveFailures = 0;
    }
    return result;
  };
   const question: { type: "noul"; instructions: string } = { type: "noul", instructions: "" };
   const rel = options.questions.rel;
   if (typeof rel === "string") question.instructions = rel;
   else if (rel !== undefined) question.instructions = rel.instructions;
   else return noteFailure(clefFailure("no-answers", "no noul question supplied", Date.now() - started));
   if (question.instructions === "") return noteFailure(clefFailure("no-answers", "no noul question supplied", Date.now() - started));
   if (Object.keys(options.state).length === 0) {
     return noteFailure(clefFailure("no-answers", "no state supplied", Date.now() - started));
   }
   let candidates: ClefCalibration[];
   try {
     if (options.clefCalibration) {
       candidates = validCalibration(options.clefCalibration, `${options.clefCalibration.task_id}.v${options.clefCalibration.version}.json`)
         ? [options.clefCalibration]
         : [];
     } else {
       const dir = process.env.JEV_CLEF_CALIBRATION_DIR;
       candidates = dir ? await loadCalibrations(dir) : [];
     }
   } catch {
     return noteFailure(clefFailure("uncalibrated", "calibration load failed", Date.now() - started));
   }
   const fingerprint = options.clefFingerprint ?? parseFingerprint(process.env.JEV_CLEF_FINGERPRINT);
   const stateKeys = Object.keys(options.state);
   let hash: string;
   try {
     hash = questionSha(question, stateKeys);
   } catch {
     return noteFailure(clefFailure("uncalibrated", "question is not calibratable", Date.now() - started));
   }
   const task = candidates.find((item) => item.primitive === "noul" && item.question_sha256 === hash);
   if (!task || !fingerprint
     || fingerprint.joint_head_sha256 !== task.model.joint_head_sha256
     || fingerprint.index_sha256 !== task.model.index_sha256) {
     return noteFailure(clefFailure("uncalibrated", "no exact calibration and model fingerprint match", Date.now() - started));
   }
   const model = `clef-flash+platt:${task.task_id}.v${task.version}`;
   const configuredUrl = options.clefUrl ?? process.env.JEV_CLEF_URL;
   if (!configuredUrl) {
     return noteFailure(clefFailure("online-required", "Clef gateway URL is not configured", Date.now() - started));
   }
   const endpoint = clefEndpoint(configuredUrl);
   if (!endpoint) {
     return noteFailure(clefFailure("refused-unsafe", "Clef URL must be an explicit loopback gateway URL and may not use port 8010", Date.now() - started));
   }
   const timeoutMs = options.timeoutMs ?? Number(process.env.JEV_CLEF_TIMEOUT_MS ?? CLEF_DEFAULT_TIMEOUT_MS);
   if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
     return noteFailure(clefFailure("online-required", "JEV_CLEF_TIMEOUT_MS must be a positive integer", Date.now() - started));
   }
   const body = JSON.stringify({ model: CLEF_MODEL_ID, state: options.state, questions: { [task.question_key]: question } });
   if (body.length > CLEF_REQUEST_BYTE_CAP) {
     return noteFailure(clefFailure("size-limit", "Clef request exceeds the size preflight", Date.now() - started));
   }
   let res: Response;
   try {
     res = await (options.fetchImpl ?? globalThis.fetch)(endpoint.toString(), {
       method: "POST",
       headers: { "content-type": "application/json" },
       body,
       signal: AbortSignal.timeout(timeoutMs),
     });
   } catch (error) {
     return noteFailure(clefFailure("transport", error instanceof Error ? error.message : error, Date.now() - started, model));
   }
   const latencyMs = Date.now() - started;
   if (!res.ok) {
     return noteFailure(clefFailure("http", `Clef HTTP ${res.status}`, latencyMs, model));
   }
   let parsed: unknown;
   try {
     parsed = await res.json();
   } catch {
     return noteFailure(clefFailure("non-json", "Clef response was not JSON", latencyMs, model));
   }
   let envelope: Record<string, unknown>;
   try {
     envelope = asRecord(parsed, "Clef response");
   } catch {
     return noteFailure(clefFailure("no-answers", "Clef response was not an object", latencyMs, model));
   }
   if (!("answers" in envelope)) {
     return noteFailure(clefFailure("no-answers", "Clef response carried no answers object", latencyMs, model));
   }
   const usage = readUsage(envelope.usage);
   if (usage && usage.input_tokens >= TRUNCATION_LIMIT) {
     return noteFailure(clefFailure("truncated", `Clef input_tokens=${usage.input_tokens} reaches the truncation limit`, latencyMs, model));
   }
   const answers = envelope.answers;
   if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
     return noteFailure(clefFailure("no-answers", "Clef response carried no answers object", latencyMs, model));
   }
   // Guarded above: non-null object; read the calibration-bound answer key.
   const table: Record<string, unknown> = answers as Record<string, unknown>;
   const answer = Reflect.get(table, task.question_key);
   if (answer === undefined) {
     return noteFailure(clefFailure("no-answers", `Clef response omitted ${task.question_key}`, latencyMs, model));
   }
   let raw: number;
   try {
     raw = validateNoulAnswer(answer);
   } catch {
     return noteFailure(clefFailure("no-answers", "invalid Clef Noul", latencyMs, model));
   }
   let mapped: number;
   try {
     mapped = plattMap(raw, task.map);
   } catch {
     return noteFailure(clefFailure("no-answers", "invalid Clef Noul", latencyMs, model));
   }
   clefConsecutiveFailures = 0;
   // CLI convention: the gateway answers under the calibration key; the
   // filter consumes it as `rel`.
  return { ok: true, scores: { rel: mapped }, latencyMs, model, ...(usage ? { usage } : {}) };
}

export const CONCURRENCY = 4;
export const FILTER_DEADLINE_MS = 1500;

/** Per-turn scoring budget (jev-9cqw-live): measured single-call p95 is
 * 282ms over 7d (n=1951) and 457ms in a loaded window; P95_LATENCY_MS=500
 * covers both. ceil(items/CONCURRENCY) waves, never below the old floor. */
export const P95_LATENCY_MS = 500;
export function filterBudgetMs(items: number): number {
  return Math.max(FILTER_DEADLINE_MS, Math.ceil(Math.max(items, 0) / CONCURRENCY) * P95_LATENCY_MS);
}

/** Hard ceiling for the whole before_agent_start handler. omp kills a handler at 30 s and shows an
 * error in the user's pane (seen in clutterfreespaces.ios 2026-10-04 03:00Z, twice). At the budget
 * the turn proceeds with every memory kept (the fail-safe side). */
export const HANDLER_BUDGET_MS = 20000;
/** Log rows are queued, never awaited on the turn path; at most this long is spent letting the
 * queue drain before the handler returns. A stalled disk delays the log, not the turn. */
export const LOG_FLUSH_MS = 250;
/** Queued log rows beyond this are dropped (counted) so a stalled disk cannot grow memory. */
export const MAX_PENDING_LOG_ROWS = 200;
/** A switch-file read slower than this counts as "switch off" (no pruning). */
export const SWITCH_READ_MS = 250;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  // Never keep the omp process (or a test run) alive just for a budget timer.
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return promise;
}


export type MemoryItem = {
  /** Cleaned judgment key. Identical cleaning/slicing to the serial
   * incumbent, so recorded-transport replay decides exactly the same. */
  text: string;
  /** Index into the parsed element-text array (0 when sys is one string). */
  element: number;
  /** Char offsets of the RAW line within that element text (end excludes \n). */
  start: number;
  end: number;
  /** sha256 of the raw line bytes; prune re-validates before removing. */
  hash: string;
};

/** Memory bullets live in the system prompt (omp memory backend injects
 * there), never in conversation messages: live `context`-event payloads
 * carry only user/assistant/toolResult/developer roles (jev-s47b:
 * 4,275 messages, zero system-role). Parse the prompt text, not messages. */
export function systemPromptText(sys: unknown): string {
  if (typeof sys === "string") return sys;
  if (Array.isArray(sys)) {
    const parts: string[] = [];
    for (const block of sys) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block === "object") {
        const text = (block as Record<string, unknown>)["text"];
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join("\n");
  }
  return JSON.stringify(sys ?? "");
}

/** All memory occurrences in one element text, with exact spans. Each
 * occurrence must lie inside a validated recall block (`<memories>` pair or
 * the EE tail); identically-worded lines anywhere else are not occurrences
 * and can never be pruned (COD hazard: instruction echo of a recall line). */
export function occurrencesIn(text: string, element: number): MemoryItem[] {
  const blocks: Array<{ body: string; base: number }> = [];
  const memRe = /<memories>([\s\S]*?)<\/memories>/g;
  let m: RegExpExecArray | null;
  while ((m = memRe.exec(text)) !== null) {
    blocks.push({ body: m[1], base: m.index + "<memories>".length });
  }
  const eeIndex = text.indexOf("Task-relevant local EE memories");
  if (eeIndex >= 0) blocks.push({ body: text.slice(eeIndex), base: eeIndex });
  const out: MemoryItem[] = [];
  for (const block of blocks) {
    let off = 0;
    for (const line of block.body.split("\n")) {
      const start = block.base + off;
      const end = start + line.length;
      off = end - block.base + 1;
      const clean = line.replace(/^[\s>*•\-–\d.)]+/, "").trim();
      if (clean.length > 1) {
        out.push({
          text: clean.slice(0, 2000),
          element,
          start,
          end,
          hash: createHash("sha256").update(line).digest("hex"),
        });
      }
    }
  }
  return out;
}

/** Every occurrence across all elements, judgment order (first-seen wins). */
export function parseOccurrences(sys: unknown): MemoryItem[] {
  const texts = Array.isArray(sys) ? (sys as unknown[]).map((b) => (typeof b === "string" ? b : systemPromptText(b))) : [systemPromptText(sys)];
  const out: MemoryItem[] = [];
  texts.forEach((text, element) => {
    out.push(...occurrencesIn(text, element));
  });
  return out;
}

/** Genuine memory bullets from a system prompt. Each prompt element is parsed
 * separately: recall arrives as its own appended element, and joining first
 * would merge the instruction mention (no closing tag) with the recall close,
 * flooding the cap with static prompt text between them (live 2026-10-01:
 * merged span swallowed the whole tool-routes section). Judgments dedupe by
 * text (first occurrence wins); every occurrence address is retained by
 * parseOccurrences for span-scoped pruning. */
export function parseSystemMemories(sys: unknown): MemoryItem[] {
  const seen: Record<string, true> = {};
  const items: MemoryItem[] = [];
  for (const item of parseOccurrences(sys)) {
    if (seen[item.text]) continue;
    seen[item.text] = true;
    items.push(item);
  }
  return items;
}

/** Removal scope (jev-9cqw AFTER: non-jev drop bar 30/30 PASS 2026-10-02):
 * removal applies in every repo with a known session cwd; null provenance
 * (unknown cwd) stays shadow fail-safe. Same global switch file. */
export function inEnforceScope(repo: string | null): boolean {
  return repo !== null && repo.length > 0;
}

export async function enforceEnabled(switchPath: string): Promise<boolean> {
  try {
    await readFile(switchPath, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Splice validated drop spans out of one element text. A span applies only
 * when the current bytes still hash to the recorded hash (changed source
 * keeps); removal covers the raw line plus its newline, so blank separators
 * and every non-memory byte survive exactly as the line filter left them. */
function pruneText(text: string, spans: MemoryItem[]): string {
  const good = spans
    .filter((s) => text.slice(s.start, s.end).length === s.end - s.start
      && createHash("sha256").update(text.slice(s.start, s.end)).digest("hex") === s.hash)
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of good) {
    const nl = out[s.end] === "\n" ? 1 : 0;
    const lead = nl === 0 && s.start > 0 && out[s.start - 1] === "\n" ? 1 : 0;
    out = out.slice(0, s.start - lead) + out.slice(s.end + nl);
  }
  return out;
}

/** Drop exactly the validated recall occurrences, byte-preserving everything
 * else. Only spans recorded by parseOccurrences are eligible: identically
 * worded lines outside a recall block, changed spans (hash mismatch), and
 * unknown element shapes all pass through unchanged. Keeps never touched. */
export function pruneSystemPrompt(sys: unknown, dropped: MemoryItem[]): unknown {
  if (dropped.length === 0) return sys;
  const byElement = new Map<number, MemoryItem[]>();
  for (const s of dropped) {
    const list = byElement.get(s.element) ?? [];
    list.push(s);
    byElement.set(s.element, list);
  }
  const texts = Array.isArray(sys)
    ? (sys as unknown[]).map((b) => (typeof b === "string" ? b : systemPromptText(b)))
    : null;
  if (typeof sys === "string") return pruneText(sys, byElement.get(0) ?? []);
  if (Array.isArray(sys)) {
    return (sys as unknown[]).map((b, i) => {
      const text = texts?.[i] ?? "";
      if (typeof b === "string") return pruneText(text, byElement.get(i) ?? []);
      if (b && typeof b === "object" && typeof (b as Record<string, unknown>)["text"] === "string") {
        return { ...(b as Record<string, unknown>), text: pruneText(text, byElement.get(i) ?? []) };
      }
      return b;
    });
  }
  return sys;
}

const INSTRUCTIONS = "Memory: `memory`. Current request: `prompt`. Is this memory relevant to the current request?";


type Append = (path: string, line: string) => Promise<void>;
export type FilterDeps = { ask?: Ask; cap?: number; path?: string; sidecarPath?: string; now?: () => string; switchPath?: string; cap3SwitchPath?: string; append?: Append };

const appendLine: Append = async (path, line) => {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, { mode: 0o600 });
};

export function makeBeforeAgentStartHandler(deps: FilterDeps = {}) {
  const switchPath = deps.switchPath ?? process.env.JEV_MEMORY_FILTER_ENFORCE_PATH ?? join(homedir(), ".local", "state", "jev", "memory-filter-enforce");
  const cap3SwitchPath = deps.cap3SwitchPath ?? process.env.JEV_MEMORY_CAP3_PATH ?? join(homedir(), ".local", "state", "jev", "memory-cap3");
  const ask = deps.ask ?? askClefNoul;
  const cap = deps.cap ?? MAX_DAILY_CALLS;
  const path = deps.path ?? process.env.JEV_MEMORY_FILTER_LOG_PATH ?? join(homedir(), ".local", "state", "jev", "memory-filter.jsonl");
  const sidecar = deps.sidecarPath ?? process.env.JEV_MEMORY_FILTER_SIDECAR_PATH ?? join(homedir(), ".local", "state", "jev", "memory-filter-full.jsonl");
  const now = deps.now ?? (() => new Date().toISOString());
  let day = "";
  let calls = 0;
  let paused = false;
  // Per-instance memo: re-entry retries and repeated turns resubmit identical
  // (prompt, memory) pairs. Reuse the verdict instead of re-spending a call.
  const memo = new Map<string, { noul: number; decision: string; inputTokens: number | null }>();
  let fireRepo: string | null = null;
  // Log rows go through one FIFO queue that the turn never waits on beyond LOG_FLUSH_MS. A stalled
  // disk then delays (or, past MAX_PENDING_LOG_ROWS, drops) log rows; it never holds the turn.
  const append = deps.append ?? appendLine;
  let logQueue: Promise<void> = Promise.resolve();
  let pendingRows = 0;
  const enqueue = (file: string, row: Record<string, unknown>): Promise<void> => {
    if (pendingRows >= MAX_PENDING_LOG_ROWS) return Promise.resolve();
    pendingRows += 1;
    const line = JSON.stringify({
      ...row,
      instanceStartedAt: INSTANCE_STARTED_AT,
      loadedCommit: LOADED_COMMIT,
      repo: fireRepo,
    }) + "\n";
    logQueue = logQueue
      .then(() => append(file, line))
      .catch(() => {
        // Logging never blocks the turn.
      })
      .finally(() => {
        pendingRows -= 1;
      });
    return Promise.resolve();
  };
  const write = (row: Record<string, unknown>): Promise<void> => enqueue(path, row);
  const writeSidecar = (row: Record<string, unknown>): Promise<void> => enqueue(sidecar, row);
  // A switch read that stalls counts as "off": no pruning is the safe side.
  const switchOn = (file: string): Promise<boolean> => Promise.race([enforceEnabled(file), sleep(SWITCH_READ_MS).then(() => false)]);
  const body = async (event: unknown, ctx?: unknown): Promise<undefined | { systemPrompt: unknown }> => {
    const droppedTexts = new Set<string>();
    try {
      const ev = (event ?? {}) as Record<string, unknown>;
      const rawPrompt = ev["prompt"];
      const prompt = (typeof rawPrompt === "string" ? rawPrompt : JSON.stringify(rawPrompt ?? "")).slice(0, PROMPT_CHARS);
      if (!prompt) return undefined;
      let sys: unknown;
      try {
        sys = (ctx as { getSystemPrompt?: () => unknown } | undefined)?.getSystemPrompt?.() ?? ev["systemPrompt"];
      } catch {
        return undefined;
      }
      const currentDay = now().slice(0, 10);
      fireRepo = (ctx as { cwd?: string } | undefined)?.cwd ?? null;
      if (currentDay !== day) {
        day = currentDay;
        calls = 0;
        paused = false;
      }
      const occurrences = parseOccurrences(sys);
      const seen: Record<string, true> = {};
      const items = occurrences
        .filter((item) => {
          if (seen[item.text]) return false;
          seen[item.text] = true;
          return true;
        })
        .slice(0, MAX_ITEMS_PER_TURN);
      // Cap-3 shipment (jev-8c09): mechanical top-3 rank cut, switch-gated,
      // default OFF. When the switch file exists and >3 memories parsed,
      // drop the 4th+ spans and return the pruned prompt, skipping Jev
      // scoring. If absent (or <=3 items), cap-3 leaves the prompt untouched;
      // Jev scoring is separately gated by the enforce switch below.
      const promptHash = createHash("sha256").update(prompt).digest("hex");
      if (items.length > CAP3_KEEP && (await switchOn(cap3SwitchPath))) {
        const dropped = items.slice(CAP3_KEEP);
        if (inEnforceScope(fireRepo)) {
          for (const item of dropped) {
            const memoryHash = createHash("sha256").update(item.text).digest("hex");
            await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: MODEL, status: "cap3-pruned", promptHash, memoryHash, noul: null, decision: "prune", tokensSaved: Math.floor(item.text.length / 4), latencyMs: null, inputTokens: null });
            await writeSidecar({ schema: SIDECAR_SCHEMA, ts: now(), instance: INSTANCE, model: MODEL, status: "cap3-pruned", promptHash, memoryHash, prompt, memory: item.text, noul: null, decision: "prune" });
          }
          return { systemPrompt: pruneSystemPrompt(sys, dropped) };
        }
        await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: MODEL, status: "cap3-shadowed", promptHash, memoryHash: null, noul: null, decision: "would-prune", removed: dropped.length, kept: CAP3_KEEP, tokensSaved: 0, latencyMs: null, inputTokens: null });
      }
      // Scoring is opt-in via the same switch that permits enforcement. When
      // it is absent, keep every memory and record the unscored volume without
      // starting a model request.
      if (items.length > 0 && !(await switchOn(switchPath))) {
        for (const item of items) {
          const memoryHash = createHash("sha256").update(item.text).digest("hex");
          await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: MODEL, status: "scoring-off", promptHash, memoryHash, noul: null, decision: "keep", tokensSaved: 0, latencyMs: null, inputTokens: null });
        }
        return undefined;
      }
      // Phase 1 (synchronous, item order): memo hits and cap reservation.
      // Cap counting is identical to the serial incumbent: first-come wins.
      const slots: Array<{ item: MemoryItem; memoryHash: string; memoKey: string }> = [];
      for (const item of items) {
        const memoryHash = createHash("sha256").update(item.text).digest("hex");
        const memoKey = promptHash + ":" + memoryHash;
        const cached = memo.get(memoKey);
        if (cached !== undefined) {
          if (cached.decision === "drop") droppedTexts.add(item.text);
          await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: MODEL, status: "memo", promptHash, memoryHash, noul: cached.noul, decision: cached.decision, tokensSaved: cached.decision === "drop" ? Math.floor(item.text.length / 4) : 0, latencyMs: null, inputTokens: cached.inputTokens });
          await writeSidecar({ schema: SIDECAR_SCHEMA, ts: now(), instance: INSTANCE, model: MODEL, status: "memo", promptHash, memoryHash, prompt, memory: item.text, noul: cached.noul, decision: cached.decision });
          continue;
        }
        if (paused || calls >= cap) {
          await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: MODEL, status: paused ? "paused" : "daily-cap", promptHash, memoryHash, noul: null, decision: "keep", tokensSaved: 0, latencyMs: null, inputTokens: null });
          // Volume visibility (jev-i20b): the item was present but unscored.
          await writeSidecar({ schema: SIDECAR_SCHEMA, ts: now(), instance: INSTANCE, model: MODEL, status: paused ? "paused" : "daily-cap", promptHash, memoryHash, prompt, memory: item.text, noul: null, decision: "keep" });
          continue;
        }
        calls += 1;
        slots.push({ item, memoryHash, memoKey });
      }
      // Phase 2: at most CONCURRENCY asks in flight, FILTER_DEADLINE_MS total.
      // Unresolved at the deadline keeps (logged); late answers are ignored
      // for decisions and logged late-ignored for spend visibility.
      const settled = new Array<boolean>(slots.length).fill(false);
      // Claim-before-write: the deadline loop awaits between rows, so a late
      // settle can complete mid-loop. Every terminal row must win this claim
      // first, or one slot emits two rows (live-found 2026-10-02: 22 rows for
      // 20 slots, deadline-keep + late-ignored on the same slot).
      const claim = (idx: number): boolean => {
        if (settled[idx]) return false;
        settled[idx] = true;
        return true;
      };
      let timedOut = false;
      const settle = async (idx: number): Promise<void> => {
        const slot = slots[idx];
        const t0 = Date.now();
        let result: JevResult;
        try {
          result = await ask({
            state: { prompt, memory: slot.item.text },
            questions: { rel: { instructions: INSTRUCTIONS } },
            model: MODEL,
            timeoutMs: CALL_TIMEOUT_MS,
          });
        } catch (error) {
          // Post-deadline failures leave the row to the deadline loop.
          if (!timedOut && claim(idx)) {
            await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: MODEL, status: "fail_open", promptHash, memoryHash: slot.memoryHash, noul: null, decision: "keep", tokensSaved: 0, latencyMs: Date.now() - t0, inputTokens: null, error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (timedOut) {
          if (claim(idx)) {
            await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: result.model, status: "late-ignored", promptHash, memoryHash: slot.memoryHash, noul: null, decision: "keep", tokensSaved: 0, latencyMs: result.latencyMs, inputTokens: "usage" in result && result.usage ? result.usage.input_tokens : null });
          }
          return;
        }
        if (!result.ok) {
          if (/\bHTTP (?:401|402|403)\b/.test(result.error)) paused = true;
          // Post-deadline failures leave the row to the deadline loop.
          if (!timedOut && claim(idx)) {
            await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: result.model, status: "fail_open", promptHash, memoryHash: slot.memoryHash, noul: null, decision: "keep", tokensSaved: 0, latencyMs: result.latencyMs, inputTokens: null, error: result.error });
          }
          return;
        }
        const noul = result.scores["rel"];
        // Contract mirror of kit finiteProbability: finite and in [0,1].
        if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
          // Post-deadline invalid answers keep spend visible as late-ignored.
          if (!timedOut && claim(idx)) {
            await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: result.model, status: "invalid-keep", promptHash, memoryHash: slot.memoryHash, noul: null, decision: "keep", tokensSaved: 0, latencyMs: result.latencyMs, inputTokens: result.usage?.input_tokens ?? null });
          } else if (timedOut && claim(idx)) {
            await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: result.model, status: "late-ignored", promptHash, memoryHash: slot.memoryHash, noul: null, decision: "keep", tokensSaved: 0, latencyMs: result.latencyMs, inputTokens: result.usage?.input_tokens ?? null, error: "invalid-score" });
          }
          return;
        }
        const drop = noul < CUT;
        const decision = drop ? "drop" : "keep";
        if (!timedOut && claim(idx)) {
          if (memo.size >= MAX_MEMO) {
            const oldest = memo.keys().next();
            if (!oldest.done) memo.delete(oldest.value);
          }
          memo.set(slot.memoKey, { noul, decision, inputTokens: result.usage?.input_tokens ?? null });
          if (drop) droppedTexts.add(slot.item.text);
          await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: result.model, status: "scored", promptHash, memoryHash: slot.memoryHash, noul, decision, tokensSaved: drop ? Math.floor(slot.item.text.length / 4) : 0, latencyMs: result.latencyMs, inputTokens: result.usage?.input_tokens ?? null });
          await writeSidecar({ schema: SIDECAR_SCHEMA, ts: now(), instance: INSTANCE, model: result.model, status: "scored", promptHash, memoryHash: slot.memoryHash, prompt, memory: slot.item.text, noul, decision });
        }
      };
      const deadlineAt = Date.now() + filterBudgetMs(slots.length);
      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (timedOut || Date.now() >= deadlineAt) return;
          const idx = cursor;
          cursor += 1;
          if (idx >= slots.length) return;
          await settle(idx);
        }
      };
      const workers: Array<Promise<void>> = [];
      for (let w = 0; w < CONCURRENCY && w < slots.length; w += 1) workers.push(worker());
      await Promise.race([
        Promise.all(workers),
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadlineAt - Date.now()))),
      ]);
      timedOut = true;
      for (let idx = 0; idx < slots.length; idx += 1) {
        if (claim(idx)) {
          const slot = slots[idx];
          await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: MODEL, status: "deadline-keep", promptHash, memoryHash: slot.memoryHash, noul: null, decision: "keep", tokensSaved: 0, latencyMs: null, inputTokens: null });
        }
      }
      const dropSpans = occurrences.filter((o) => droppedTexts.has(o.text));
      if (dropSpans.length > 0 && (await switchOn(switchPath))) {
        const kept = items.length - droppedTexts.size;
        if (inEnforceScope(fireRepo)) {
          await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: MODEL, status: "enforced", promptHash, memoryHash: null, noul: null, decision: "prune", removed: dropSpans.length, kept, tokensSaved: 0, latencyMs: null, inputTokens: null });
          return { systemPrompt: pruneSystemPrompt(sys, dropSpans) };
        }
        await write({ schema: LOG_SCHEMA, ts: now(), instance: INSTANCE, model: MODEL, status: "shadowed", promptHash, memoryHash: null, noul: null, decision: "would-drop", removed: dropSpans.length, kept, tokensSaved: 0, latencyMs: null, inputTokens: null });
      }
    } catch {
      // Shadow failures never affect the turn.
    }
    return undefined;
  };
  return async (event: unknown, ctx?: unknown): Promise<undefined | { systemPrompt: unknown }> => {
    // Past HANDLER_BUDGET_MS the turn proceeds with every memory kept; late work is ignored.
    const result = await Promise.race([body(event, ctx), sleep(HANDLER_BUDGET_MS).then(() => undefined)]);
    await Promise.race([logQueue, sleep(LOG_FLUSH_MS)]);
    return result;
  };
}
/** Double-registration guard: in repos where the project file and a global
 * entry resolve to different spellings, the loader binds both in one session.
 * The marker lives on the per-session binding, so fresh sessions (and
 * subagents, which rebind) still register exactly once each. */
const REGISTERED_MARK = "__jevMemoryFilterRegistered";
export default function jevMemoryFilterExtension(
  pi: { on: (event: string, handler: (event: unknown, ctx?: unknown) => Promise<unknown>) => void },
  deps: FilterDeps = {},
): void {
  const binding = pi as unknown as Record<string, unknown>;
  if (binding[REGISTERED_MARK] === true) return;
  binding[REGISTERED_MARK] = true;
  pi.on("before_agent_start", makeBeforeAgentStartHandler(deps));
}
