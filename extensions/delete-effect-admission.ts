/**
 * delete-effect-admission: cross-adapter protected DELETE approval admission.
 *
 * Bead ompkit-xa5s.23 (DELETEEFFECT).
 *
 * Observed violation (AM55261/55273, Gray55184/p5wn.2): a shell `rm` on a
 * protected staging path met SLB CAUTION/Proceed with no valid approval, then
 * a structured edit REM deleted the SAME file with no admission at all. The
 * kit SLB bridge (`slb-guard-fail-closed.ts`) only sees `toolName === "bash"`,
 * and the native gate unconditionally allows `tool_name: "Edit"` payloads, so
 * the edit adapter bypasses every approval check. Exact sources:
 *   - omp edit hashline op: `@oh-my-pi/pi-coding-agent/src/edit/hashline-compact.md`
 *     ("`REM` deletes the file", header `[PATH#TAG]` with required 4-hex tag);
 *   - omp structured delete: `src/edit/index.ts` `PatchParams` "Delete" example
 *     (`{ path, edits: [{ op: "delete" }] }`) and `ApplyPatchParams` example
 *     (`*** Delete File: <path>`);
 *   - omp patch entry op: `src/edit/schemas.ts` (`"op?": "'create' | 'delete' | 'update'"`);
 *   - SLB tiers: `slb patterns list` classifies `rm <path>` (`^rm\s+[^-]`) as
 *     CAUTION with 0 minimum approvals, and the native gate answers CAUTION
 *     `rm` with `permissionDecision: "ask"`.
 *
 * This module binds both adapters to the SAME valid approval state at the
 * effect level (DELETE on an identical protected path), not by command
 * spelling. Classification only: it never executes, reads, restores, replays,
 * or retro-approves anything, and never touches the filesystem. Recoverability
 * of the original incident files remains UNKNOWN until read-only owner
 * attestation; this module asserts nothing about retention.
 *
 * Approval state is injected (`approvalOf`), so the same SLB request/approval
 * backend that governs shell commands governs structured edits: missing,
 * denied, pending, stale, or path-mismatched approval refuses both adapters
 * before effect. A valid scoped approval classifies authorized DELETE
 * consistently across adapters without executing it. Nondestructive reads and
 * ordinary non-delete edits never reach this admission (no overblock), and a
 * tool name alone grants nothing.
 */

type JsonRecord = Record<string, unknown>;

export type DeleteAdapter = "shell-rm" | "edit-rem";

export type DeleteEffect = {
  action: "DELETE";
  adapter: DeleteAdapter;
  /** Lexical target path; "" when the scope could not be bounded. */
  path: string;
  /** True when the effect could not be fully bounded: always needs approval. */
  uncertain: boolean;
};

export type DeleteApproval = {
  action: "DELETE";
  /** Exact path this approval scopes. */
  path: string;
  decision: "approved" | "denied" | "pending";
  grantedAtMs: number;
  expiresAtMs: number;
  approver: string;
  requestId: string;
};

export type ApprovalStanding =
  | "valid"
  | "missing"
  | "denied"
  | "pending"
  | "stale"
  | "mismatched";

/** Custody preserved on every verdict: actor/path/request/action/approval/time. */
export type DeleteCustody = {
  actor: string;
  path: string;
  requestId: string;
  action: "DELETE";
  adapter: DeleteAdapter;
  approval: ApprovalStanding | "uncertain";
  atMs: number;
};

export type DeleteVerdict = {
  verdict: "allow" | "deny";
  reason: string;
  custody: DeleteCustody;
};

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** Lexically collapse `.`/`..` segments without touching the filesystem. */
function collapseDots(path: string): string {
  const absolute = path.startsWith("/");
  const kept: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (kept.length > 0 && kept[kept.length - 1] !== "..") kept.pop();
      else if (!absolute) kept.push("..");
      continue;
    }
    kept.push(segment);
  }
  const joined = kept.join("/");
  if (absolute) return `/${joined}`;
  return joined === "" ? "." : joined;
}

 /** Lexical normalization only: trim, drop trailing slashes, reject NUL. No fs. */
 export function normalizeEffectPath(path: string): string | undefined {
   const trimmed = path.trim();
  if (trimmed === "" || trimmed.includes("\0")) return undefined;
  const collapsed = collapseDots(trimmed).replace(/\/+$/u, "");
  if (collapsed === "" || collapsed === "/" || collapsed === ".") return undefined;
  return collapsed;
 }

export function isProtectedPath(path: string, protectedRoots: readonly string[]): boolean {
  const target = normalizeEffectPath(path);
  if (target === undefined) return false;
  for (const root of protectedRoots) {
    const base = normalizeEffectPath(root);
    if (base === undefined) continue;
    if (target === base || target.startsWith(`${base}/`)) return true;
  }
  return false;
}

/** Longest command this classifier bounds; longer inputs fail visible (uncertain). */
const MAX_COMMAND_CHARS = 64 * 1024;

 /** Shell-ish tokenize honoring single/double quotes; undefined on truncation. */
 function tokenizeCommand(command: string): string[] | undefined {
   const tokens: string[] = [];
   let current = "";
   let quote: string | undefined;
   let hasToken = false;
   for (let i = 0; i < command.length; i += 1) {
     const ch = command[i];
     if (quote !== undefined) {
       if (ch === quote) {
         quote = undefined;
       } else {
         current += ch;
         hasToken = true;
       }
       continue;
     }
     if (ch === "'" || ch === '"') {
       quote = ch;
       hasToken = true;
       continue;
     }
     if (ch === " " || ch === "	") {
       if (hasToken) {
         tokens.push(current);
         current = "";
         hasToken = false;
       }
       continue;
     }
     current += ch;
     hasToken = true;
   }
   if (quote !== undefined) return undefined;
   if (hasToken) tokens.push(current);
   return tokens;
 }
/**
 * True when the command chains, pipes, backgrounds, substitutes, or subshells
 * outside quotes (`;`, `|`, `&`, backticks, `$(`, `(`), or ends inside a
 * quote. Single pass, no backtracking. Quoted metacharacters are literal
 * filename bytes and stay bounded; `#` comments are out of the pinned subset
 * and over-approximate as literal targets (fail-safe direction).
 */
function hasUnquotedMeta(command: string): boolean {
  let quote: string | undefined;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (
      ch === ";" ||
      ch === "|" ||
      ch === "&" ||
      ch === "`" ||
      ch === "(" ||
      (ch === "$" && command[i + 1] === "(")
    ) {
      return true;
    }
  }
  return quote !== undefined;
}

/** Target spellings this classifier cannot bound lexically: fail visible. */
const UNBOUND_TARGET = /[*?[\]$~\\]/u;
/** `rm` in command position but outside the pinned clean prefix (sudo, chaining). */
const RM_COMMAND_POSITION = /(^|[;&|]\s*)(sudo\s+)?rm(?:\s|$)/u;
 /**
  * Classify a Bash command. `rm` with resolvable targets yields one DELETE
 * effect per path. Anything outside the pinned subset below yields a single
 * uncertain DELETE (fail-closed); anything else yields [].
 *
 * Pinned subset: `rm [flags] [--] targets...` with no chaining (`;`, `&&`,
 * `||`, `|`, backticks, `$(...)`), no backslash escapes, no glob/expansion
 * characters in targets, total length within MAX_COMMAND_CHARS, and `rm` as
 * the first token. `rm` in command position elsewhere (sudo prefix, chained
 * command) is uncertain. Anything else (mentions inside arguments, quoted
 * leaders, env-prefixes) yields [] and stays under SLB native governance.
  */
 export function rmDeleteEffects(command: string): DeleteEffect[] {
   const trimmed = command.trim();
  if (trimmed.length > MAX_COMMAND_CHARS) {
    return [{ action: "DELETE", adapter: "shell-rm", path: "", uncertain: true }];
  }
  if (!/^rm(?:\s|$)/u.test(trimmed)) {
    if (!RM_COMMAND_POSITION.test(trimmed)) return [];
    return [{ action: "DELETE", adapter: "shell-rm", path: "", uncertain: true }];
  }
   if (hasUnquotedMeta(trimmed)) {
     return [{ action: "DELETE", adapter: "shell-rm", path: "", uncertain: true }];
   }
   const tokens = tokenizeCommand(trimmed);
   if (tokens === undefined || tokens[0] !== "rm") {
     return [{ action: "DELETE", adapter: "shell-rm", path: "", uncertain: true }];
   }
   const paths: string[] = [];
   let endOfFlags = false;
   for (const token of tokens.slice(1)) {
     if (!endOfFlags && token === "--") {
       endOfFlags = true;
       continue;
     }
     if (!endOfFlags && token.startsWith("-") && token !== "-") continue;
    if (UNBOUND_TARGET.test(token)) {
      return [{ action: "DELETE", adapter: "shell-rm", path: "", uncertain: true }];
    }
     const normalized = normalizeEffectPath(token);
     if (normalized === undefined) {
       return [{ action: "DELETE", adapter: "shell-rm", path: "", uncertain: true }];
     }
     paths.push(normalized);
   }
   return paths.map((path) => ({ action: "DELETE", adapter: "shell-rm", path, uncertain: false }));
 }

/**
 * Hashline section header: `[PATH#TAG]` with a required 4-hex snapshot tag
 * (omp `src/edit/hashline-compact.md`). Linear: one lazy span, both anchors.
 */
const HASHLINE_HEADER = /^\[(.+?)#[0-9a-fA-F]{4}\]$/u;

/** Apply-patch deletion line: `*** Delete File: <path>` (omp `src/edit/index.ts`). */
const DELETE_FILE_LINE = /^\*\*\* Delete File:\s*(.+?)\s*$/u;

const uncertainRem = (): DeleteEffect => ({
  action: "DELETE",
  adapter: "edit-rem",
  path: "",
  uncertain: true,
});

const boundRem = (raw: string): DeleteEffect => {
  const normalized = normalizeEffectPath(raw);
  if (normalized === undefined) return uncertainRem();
  return { action: "DELETE", adapter: "edit-rem", path: normalized, uncertain: false };
};

/**
 * Classify an Edit-tool input. Whole-file removal is `REM` in the hashline
 * patch language (target from the `[PATH#TAG]` header), `op: "delete"` in a
 * `{ path, edits }` batch (omp `PatchParams` "Delete" example), or
 * `*** Delete File: <path>` in an apply-patch `input` (omp
 * `ApplyPatchParams` example). PUT-only/replace inputs yield [] so ordinary
 * edits stay usable. REM with anything but exactly one resolvable header
 * yields uncertain DELETE (fail-closed).
 */
export function editRemEffects(input: unknown): DeleteEffect[] {
  const obj = record(input);
  if (!obj) return [uncertainRem()];

  if (typeof obj.path === "string" && Array.isArray(obj.edits)) {
    const deletesFile = obj.edits.some((entry) => record(entry)?.op === "delete");
    if (!deletesFile) return [];
    return [boundRem(obj.path)];
  }

  if (typeof obj.input === "string") {
    const lines = obj.input.split("\n");
    const deletedFiles = lines
      .map((line) => DELETE_FILE_LINE.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => match[1]);
    if (deletedFiles.length > 0) return deletedFiles.map(boundRem);
    const headers = lines
      .map((line) => HASHLINE_HEADER.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => match[1].trim());
    const hasRem = lines.some((line) => line.trim() === "REM");
    if (!hasRem) return [];
    if (headers.length !== 1) return [uncertainRem()];
    return [boundRem(headers[0])];
  }

  // Replace-style ({ path, old_string, new_string }) and unknown shapes carry
  // no whole-file removal signal; unknown shapes are the caller's to refuse.
  return [];
}

/** Single-effect alias kept for one-target callers. */
export function editRemEffect(input: unknown): DeleteEffect | undefined {
  const effects = editRemEffects(input);
  return effects.length > 0 ? effects[0] : undefined;
}

/** Effect-level classification across adapters. Never executes. */
export function deleteEffectsOf(toolName: unknown, input: unknown): DeleteEffect[] {
  if (toolName === "bash") {
    const obj = record(input);
    const command = obj && typeof obj.command === "string" ? obj.command : undefined;
    if (command === undefined) return [];
    return rmDeleteEffects(command);
  }
  if (toolName === "edit") return editRemEffects(input);
  return [];
}

export function approvalStanding(
  approval: DeleteApproval | undefined,
  effect: DeleteEffect,
  nowMs: number,
): ApprovalStanding {
  if (approval === undefined) return "missing";
  if (approval.decision === "denied") return "denied";
  if (approval.decision === "pending") return "pending";
  if (approval.action !== "DELETE") return "mismatched";
  if (normalizeEffectPath(approval.path) !== normalizeEffectPath(effect.path)) return "mismatched";
  if (approval.approver.trim() === "" || approval.requestId.trim() === "") return "mismatched";
  if (!(approval.grantedAtMs <= nowMs && nowMs <= approval.expiresAtMs)) return "stale";
  return "valid";
}

export function admitDeleteEffect(args: {
  effect: DeleteEffect;
  approval: DeleteApproval | undefined;
  protectedRoots: readonly string[];
  /** Tool call id: preserved as the request identity. */
  requestId: string;
  nowMs: number;
}): DeleteVerdict {
  const { effect, approval, protectedRoots, requestId, nowMs } = args;
  const standing = effect.uncertain ? "uncertain" : approvalStanding(approval, effect, nowMs);
  const custody: DeleteCustody = {
    actor: approval?.approver.trim() !== "" ? String(approval?.approver) : "unknown (tool_call seam)",
    path: effect.path,
    requestId,
    action: "DELETE",
    adapter: effect.adapter,
    approval: standing,
    atMs: nowMs,
  };
  if (effect.uncertain) {
    return {
      verdict: "deny",
      reason: `delete-effect: protected DELETE refused (unbounded delete scope) adapter=${effect.adapter} request=${requestId}`,
      custody,
    };
  }
  if (!isProtectedPath(effect.path, protectedRoots)) {
    return {
      verdict: "allow",
      reason: `delete-effect: ${effect.adapter} target outside protected roots; outside this admission's jurisdiction`,
      custody,
    };
  }
  if (standing === "valid") {
    return {
      verdict: "allow",
      reason: `delete-effect: valid scoped DELETE approval ${approval?.requestId} covers ${effect.path} via ${effect.adapter}`,
      custody,
    };
  }
  const defect =
    standing === "uncertain"
      ? "unbounded delete scope"
      : standing === "missing"
        ? "no approval"
        : standing === "mismatched"
          ? "approval scope mismatch"
          : `approval ${standing}`;
  return {
    verdict: "deny",
    reason: `delete-effect: protected DELETE refused (${defect}) adapter=${effect.adapter} path=${effect.path || "(unknown)"} request=${requestId}`,
    custody,
  };
}
