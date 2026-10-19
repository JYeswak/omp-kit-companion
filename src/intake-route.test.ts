import { strict as assert } from "node:assert";
import { test } from "bun:test";
import {
  formatRoute,
  resolveSeatRole,
  routeIntake,
  routeToJson,
  type RouteVerdict,
} from "./intake-route.ts";

const ROSTER = {
  roster: { chief: "lead-chief", director: "director", w1: "worker", peer: "peer-chief" },
};

function replyOf(verdict: RouteVerdict): string {
  return verdict.reply;
}

test("roster resolves known roles and UNKNOWN for strangers", () => {
  assert.equal(resolveSeatRole(ROSTER, "chief"), "lead-chief");
  assert.equal(resolveSeatRole(ROSTER, "director"), "director");
  assert.equal(resolveSeatRole(ROSTER, "w1"), "worker");
  assert.equal(resolveSeatRole(ROSTER, "peer"), "peer-chief");
  assert.equal(resolveSeatRole(ROSTER, "ghost"), "UNKNOWN");
  assert.equal(resolveSeatRole(null, "w1"), "UNKNOWN");
});

test("chief receiving 'fix this test' routes to the project director", () => {
  const verdict = routeIntake({ seat: "chief", role: "lead-chief", bead: "b1", text: "fix this test" }, ROSTER);
  assert.equal(verdict.action, "ROUTE");
  if (verdict.action !== "ROUTE") throw new Error("expected ROUTE");
  assert.equal(verdict.seat, "director");
  const printed = formatRoute(verdict).split("\n");
  assert.equal(printed[0], "ROUTE b1 -> director");
  assert.ok((printed[1] ?? "").length > 0);
  assert.deepEqual(routeToJson(verdict), { action: "ROUTE", bead: "b1", seat: "director", reply: replyOf(verdict) });
});

test("worker receiving 'fix this test' gets DO", () => {
  const verdict: RouteVerdict = routeIntake({ seat: "w1", role: "worker", bead: "b1", text: "fix this test" });
  assert.equal(verdict.action, "DO");
  assert.equal(formatRoute(verdict).split("\n")[0], "DO b1");
  assert.deepEqual(routeToJson(verdict), { action: "DO", bead: "b1", reply: replyOf(verdict) });
});

test("self-do without --role-override refuses", () => {
  const refused = routeIntake({ seat: "w1", role: "worker", bead: "b1", text: "fix this test", selfDo: true });
  assert.equal(refused.action, "REFUSE");
  const allowed = routeIntake({
    seat: "w1", role: "worker", bead: "b1", text: "fix this test",
    selfDo: true, roleOverride: "Joshua said: do it yourself",
  });
  assert.equal(allowed.action, "DO");
});

test("director receiving worker work routes to a worker", () => {
  const verdict = routeIntake({ seat: "director", role: "director", bead: "b2", text: "fix this test" }, ROSTER);
  assert.equal(verdict.action, "ROUTE");
  if (verdict.action !== "ROUTE") throw new Error("expected ROUTE");
  assert.equal(verdict.seat, "w1");
});

test("unknown seat refuses instead of routing", () => {
  const verdict = routeIntake({ seat: "ghost", role: "UNKNOWN", bead: "b3", text: "fix this test" });
  assert.equal(verdict.action, "REFUSE");
});
