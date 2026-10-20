import { describe, expect, test } from "bun:test";
import {
  admitDeleteEffect,
  approvalStanding,
  deleteEffectsOf,
  editRemEffect,
  editRemEffects,
  isProtectedPath,
  normalizeEffectPath,
  rmDeleteEffects,
  type DeleteApproval,
  type DeleteEffect,
} from "./delete-effect-admission";
import { createSlbGuard, type SlbRunResult } from "./slb-guard-fail-closed";
import { existsSync } from "node:fs";

/**
 * DELETEEFFECT specimens (bead ompkit-xa5s.23). Classification only: every
 * fixture path below is a pure string. The no-execution test at the bottom
 * proves none of them was created or removed.
 */
const ROOT = "var/agent-tmp/delete-effect-specimen";
const PROTECTED = `${ROOT}/42a2-mine.patch`;
const ROOTS = [ROOT] as const;

const NOW = 1_790_000_000_000;

function approval(over: Partial<DeleteApproval> = {}): DeleteApproval {
  return {
    action: "DELETE",
    path: PROTECTED,
    decision: "approved",
    grantedAtMs: NOW - 60_000,
    expiresAtMs: NOW + 60_000,
    approver: "Stormy",
    requestId: "slb-req-55273",
    ...over,
  };
}

const rmInput = (command: string) => ({ command });
const remInput = (path: string) => ({
  input: `*** Begin Patch\n[${path}#a1b2]\nREM\n*** End Patch\n`,
});

function admit(effect: DeleteEffect, ap: DeleteApproval | undefined) {
  return admitDeleteEffect({
    effect,
    approval: ap,
    protectedRoots: [...ROOTS],
    requestId: "call-fixture",
    nowMs: NOW,
  });
}

describe("delete-effect classification", () => {
  test("shell rm on the protected path yields a bounded DELETE", () => {
    expect(rmDeleteEffects(`rm ${PROTECTED}`)).toEqual([
      { action: "DELETE", adapter: "shell-rm", path: PROTECTED, uncertain: false },
    ]);
  });

  test("rm -rf spelling yields the same effect identity (not just spelling)", () => {
    expect(rmDeleteEffects(`rm -rf -- ${PROTECTED}`)).toEqual([
      { action: "DELETE", adapter: "shell-rm", path: PROTECTED, uncertain: false },
    ]);
  });

  test("edit REM on the exact same path yields the same DELETE identity", () => {
    expect(editRemEffect(remInput(PROTECTED))).toEqual({
      action: "DELETE",
      adapter: "edit-rem",
      path: PROTECTED,
      uncertain: false,
    });
  });

  test("apply-patch Delete File line yields DELETE", () => {
    expect(
      editRemEffects({
        input: `*** Begin Patch\n*** Delete File: ${PROTECTED}\n*** End Patch\n`,
      }),
    ).toEqual([{ action: "DELETE", adapter: "edit-rem", path: PROTECTED, uncertain: false }]);
  });

  test("multi-header REM is uncertain; dot segments collapse lexically", () => {
    expect(
      editRemEffects({
        input: `*** Begin Patch\n[${PROTECTED}#a1b2]\n[${ROOT}/b.patch#c3d4]\nREM\n*** End Patch\n`,
      }),
    ).toMatchObject([{ uncertain: true }]);
    expect(normalizeEffectPath(`${ROOT}/../other.patch`)).toBe("var/agent-tmp/other.patch");
    expect(normalizeEffectPath("./x.patch")).toBe("x.patch");
    expect(normalizeEffectPath("/")).toBeUndefined();
  });

  test("patch-batch delete op yields DELETE; PUT-only batch yields none", () => {
    expect(editRemEffect({ path: PROTECTED, edits: [{ op: "delete" }] })).toMatchObject({
      action: "DELETE",
      adapter: "edit-rem",
      path: PROTECTED,
    });
    expect(editRemEffect({ path: PROTECTED, edits: [{ op: "update", diff: "@@\n" }] })).toBeUndefined();
  });

  test("ordinary replace edit and reads yield no DELETE (no overblock)", () => {
    expect(
      editRemEffect({ path: PROTECTED, old_string: "a", new_string: "b" }),
    ).toBeUndefined();
    expect(deleteEffectsOf("read", { path: PROTECTED })).toEqual([]);
    expect(deleteEffectsOf("bash", rmInput("git status"))).toEqual([]);
  });

  test("REM without a resolvable header is uncertain, not silently scoped", () => {
    expect(editRemEffect({ input: "*** Begin Patch\nREM\n*** End Patch\n" })).toMatchObject({
      action: "DELETE",
      adapter: "edit-rem",
      uncertain: true,
    });
  });

  test("regex checklist: required match, rejects, boundary", () => {
    // Required matches.
    expect(rmDeleteEffects(`rm ${PROTECTED}`).length).toBe(1);
    // Rejects: no rm token at all.
    expect(rmDeleteEffects("git status")).toEqual([]);
    expect(rmDeleteEffects("grep -r rm file")).toEqual([]);
    // Boundary: bare `rm` deletes nothing; `rmx` is not rm.
    expect(rmDeleteEffects("rm")).toEqual([]);
    expect(rmDeleteEffects("rmx file")).toEqual([]);
    // Command position outside the clean prefix: sudo/chained are uncertain...
    expect(rmDeleteEffects("sudo rm file")).toMatchObject([{ uncertain: true }]);
    expect(rmDeleteEffects("printf a; rm file")).toMatchObject([{ uncertain: true }]);
    // ...but mentions inside arguments, quoted leaders, and env-prefixes
    // stay under SLB native governance (no extra-layer overblock).
    expect(rmDeleteEffects("VAR=1 rm file")).toEqual([]);
    expect(rmDeleteEffects('"rm file"')).toEqual([]);
  });

  test("regex checklist: chaining, substitution, globs fail visible", () => {
    expect(rmDeleteEffects(`rm ${PROTECTED}; printf hi`)).toMatchObject([{ uncertain: true }]);
    expect(rmDeleteEffects(`rm ${PROTECTED} && printf hi`)).toMatchObject([{ uncertain: true }]);
    expect(rmDeleteEffects("rm $(printf x)")).toMatchObject([{ uncertain: true }]);
    expect(rmDeleteEffects("rm `printf x`")).toMatchObject([{ uncertain: true }]);
    expect(rmDeleteEffects("rm a | tee b")).toMatchObject([{ uncertain: true }]);
    expect(rmDeleteEffects(`rm ${ROOT}/*.patch`)).toMatchObject([{ uncertain: true }]);
    expect(rmDeleteEffects("rm ~/staged.patch")).toMatchObject([{ uncertain: true }]);
    expect(rmDeleteEffects("rm 'unterminated")).toMatchObject([{ uncertain: true }]);
  });
  test("quoted metacharacters stay bounded literal targets", () => {
    expect(rmDeleteEffects("rm 'a;b'")).toMatchObject([{ path: "a;b", uncertain: false }]);
    expect(rmDeleteEffects('rm "x|y"')).toMatchObject([{ path: "x|y", uncertain: false }]);
  });

  test("regex checklist: timed long near-miss stays bounded", () => {
    const nearMiss = `rm ${"a".repeat(60_000)}-near-miss`;
    const start = performance.now();
    const effects = rmDeleteEffects(nearMiss);
    const elapsed = performance.now() - start;
    expect(effects).toHaveLength(1);
    expect(elapsed).toBeLessThan(1000);
    const oversize = `rm ${"b".repeat(70_000)}`;
    expect(rmDeleteEffects(oversize)).toMatchObject([{ uncertain: true }]);
  });

  test("quoted targets resolve; flag-like names need --", () => {
    expect(rmDeleteEffects(`rm -- "-rf-ish.patch"`)).toMatchObject([
      { path: "-rf-ish.patch", uncertain: false },
    ]);
    expect(rmDeleteEffects(`rm "a b/c.patch" 'd/e.patch'`)).toMatchObject([
      { path: "a b/c.patch", uncertain: false },
      { path: "d/e.patch", uncertain: false },
    ]);
  });
});

describe("same valid approval across adapters", () => {
  test("valid scoped approval allows shell-rm and edit-rem identically", () => {
    const ap = approval();
    const viaRm = admit(rmDeleteEffects(`rm ${PROTECTED}`)[0], ap);
    const viaRem = admit(editRemEffect(remInput(PROTECTED))!, ap);
    expect(viaRm.verdict).toBe("allow");
    expect(viaRem.verdict).toBe("allow");
    expect(viaRem.reason).toContain("slb-req-55273");
  });

  test.each([
    ["missing", undefined, "no approval"],
    ["denied", approval({ decision: "denied" }), "approval denied"],
    ["pending", approval({ decision: "pending" }), "approval pending"],
    ["stale", approval({ expiresAtMs: NOW - 1 }), "approval stale"],
    ["mismatched", approval({ path: `${ROOT}/other.patch` }), "approval scope mismatch"],
  ])("%s approval refuses both adapters before effect", (_name, ap, fragment) => {
    for (const effect of [
      rmDeleteEffects(`rm ${PROTECTED}`)[0],
      editRemEffect(remInput(PROTECTED))!,
    ]) {
      const verdict = admit(effect, ap);
      expect(verdict.verdict).toBe("deny");
      expect(verdict.reason).toContain(fragment);
      expect(verdict.reason).toContain(effect.adapter);
      expect(verdict.custody).toMatchObject({
        path: PROTECTED,
        requestId: "call-fixture",
        action: "DELETE",
        adapter: effect.adapter,
        atMs: NOW,
      });
    }
  });

  test("uncertain scope refuses even with a valid approval", () => {
    const verdict = admit(
      { action: "DELETE", adapter: "edit-rem", path: "", uncertain: true },
      approval(),
    );
    expect(verdict.verdict).toBe("deny");
    expect(verdict.reason).toContain("unbounded delete scope");
  });

  test("tool name alone grants nothing and overblocks nothing", () => {
    // PUT-only edit with no approval passes through (not our jurisdiction).
    expect(deleteEffectsOf("edit", { path: PROTECTED, old_string: "a", new_string: "b" })).toEqual([]);
    // REM without approval is refused even though the tool is the ordinary editor.
    const verdict = admit(editRemEffect(remInput(PROTECTED))!, undefined);
    expect(verdict.verdict).toBe("deny");
  });

  test("non-protected targets stay outside jurisdiction", () => {
    expect(isProtectedPath(`${ROOT}/../elsewhere.patch`, ROOTS)).toBe(false);
    const verdict = admit(
      { action: "DELETE", adapter: "shell-rm", path: "elsewhere.patch", uncertain: false },
      undefined,
    );
    expect(verdict.verdict).toBe("allow");
    expect(verdict.reason).toContain("outside this admission's jurisdiction");
  });

  test("standing maps every defect distinctly", () => {
    const effect: DeleteEffect = { action: "DELETE", adapter: "shell-rm", path: PROTECTED, uncertain: false };
    expect(approvalStanding(approval(), effect, NOW)).toBe("valid");
    expect(approvalStanding(undefined, effect, NOW)).toBe("missing");
    expect(approvalStanding(approval({ approver: "" }), effect, NOW)).toBe("mismatched");
    expect(approvalStanding(approval({ grantedAtMs: NOW + 1 }), effect, NOW)).toBe("stale");
  });

  test("custody carries no secret material", () => {
    const verdict = admit(editRemEffect(remInput(PROTECTED))!, approval());
    const text = JSON.stringify(verdict);
    expect(text).not.toMatch(/token|secret|key|password/i);
    expect(verdict.custody.actor).toBe("Stormy");
  });

  test("classification never executes: specimen paths absent before and after", () => {
    expect(existsSync(PROTECTED)).toBe(false);
    expect(existsSync(ROOT)).toBe(false);
    admitDeleteEffect({
      effect: { action: "DELETE", adapter: "edit-rem", path: PROTECTED, uncertain: false },
      approval: approval(),
      protectedRoots: [...ROOTS],
      requestId: "call-fixture",
      nowMs: NOW,
    });
    expect(existsSync(PROTECTED)).toBe(false);
    expect(existsSync(ROOT)).toBe(false);
  });
});

describe("canonical bridge wiring (guard-removal negative)", () => {
  // This block exercises the pre-effect seam itself: if the admission wiring
  // is removed from createSlbGuard, these refuse-before-effect assertions fail.
  const allowNative = (): Promise<SlbRunResult> => Promise.resolve({
    exitCode: 0,
    stdout:
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n',
    stderr: "",
    timedOut: false,
  });
  const wired = (
    toolName: string,
    input: unknown,
    ap: DeleteApproval | undefined,
  ) => {
    const bridge = createSlbGuard(allowNative, {
      protectedRoots: [...ROOTS],
      approvalOf: ap === undefined ? () => undefined : () => ap,
      nowMs: () => NOW,
    });
    return bridge.handle(
      { type: "tool_call", toolName, toolCallId: "call-fixture", input },
      { cwd: "var/agent-tmp/delete-effect-fixture", sessionManager: { getSessionId: () => "s" } },
    );
  };

  test("edit REM without approval is refused at the bridge", async () => {
    const result = await wired("edit", remInput(PROTECTED), undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason ?? "").toContain("edit-rem");
  });

  test("edit REM with the same valid approval is admitted at the bridge", async () => {
    const result = await wired("edit", remInput(PROTECTED), approval());
    expect(result).toBeUndefined();
  });

  test("ordinary edit still passes the bridge with admission configured", async () => {
    const result = await wired(
      "edit",
      { path: PROTECTED, old_string: "a", new_string: "b" },
      undefined,
    );
    expect(result).toBeUndefined();
  });

  test("unconfigured bridge keeps prior behavior (edit passes through)", async () => {
    const bridge = createSlbGuard(allowNative);
    const result = await bridge.handle(
      { type: "tool_call", toolName: "edit", toolCallId: "call-fixture", input: remInput(PROTECTED) },
      { cwd: "var/agent-tmp/delete-effect-fixture" },
    );
    expect(result).toBeUndefined();
  });
});
