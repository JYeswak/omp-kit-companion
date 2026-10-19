// intake-route: role resolution + DO/ROUTE print only (no delivery).
// INTAKE1 slice of ompkit-fp72.19.1.19. Pure functions; no I/O except the
// file-backed roster helper, which reads one small JSON file synchronously.

import { readFileSync } from "node:fs";

export type SeatRole = "worker" | "director" | "peer-chief" | "lead-chief" | "UNKNOWN";

const CANONICAL_ROLES: Readonly<Record<string, SeatRole>> = {
  worker: "worker",
  director: "director",
  "peer-chief": "peer-chief",
  peer_chief: "peer-chief",
  peerchief: "peer-chief",
  "lead-chief": "lead-chief",
  lead_chief: "lead-chief",
  leadchief: "lead-chief",
};

function canonRole(value: unknown): SeatRole | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  return CANONICAL_ROLES[key] ?? null;
}

/** Resolve a seat's role from a parsed fleet-watch.json value. Unknown seat -> UNKNOWN. */
export function resolveSeatRole(config: unknown, seat: string): SeatRole {
  if (typeof config !== "object" || config === null) return "UNKNOWN";
  const record = config as Record<string, unknown>;
  const wanted = seat.trim();
  // 1. Explicit roster/seats map: { "<seat>": "<role>" }.
  for (const key of ["roster", "seats", "seatRoles", "seat_roles"]) {
    const map = record[key];
    if (typeof map === "object" && map !== null) {
      for (const [name, role] of Object.entries(map as Record<string, unknown>)) {
        if (name === wanted) return canonRole(role) ?? "UNKNOWN";
      }
    }
  }
  // 2. sessions[] derivation: coordinator panes direct, worker panes implement.
  const sessions = record["sessions"];
  if (Array.isArray(sessions)) {
    let workerHit = false;
    for (const entry of sessions) {
      if (typeof entry !== "object" || entry === null) continue;
      const row = entry as Record<string, unknown>;
      if (typeof row["coordinatorPane"] === "string" && row["coordinatorPane"] === wanted) return "director";
      const panes = row["workerPanes"];
      if (Array.isArray(panes) && panes.some((pane) => pane === wanted)) workerHit = true;
    }
    if (workerHit) return "worker";
  }
  // 3. Named chief seat -> lead-chief.
  const chief = record["chief"];
  if (typeof chief === "object" && chief !== null) {
    const name = (chief as Record<string, unknown>)["seat"];
    if (name === wanted) return "lead-chief";
  } else if (chief === wanted) return "lead-chief";
  return "UNKNOWN";
}

/** File-backed helper: read fleet-watch.json once, resolve one seat. Never throws. */
export function resolveSeatRoleFromFile(configPath: string, seat: string): SeatRole {
  try {
    return resolveSeatRole(JSON.parse(readFileSync(configPath, "utf8")), seat);
  } catch {
    return "UNKNOWN";
  }
}

/** Work-owner classification: implementation verbs belong to the worker role. */
const WORKER_OWNED = /\bfix\b|\btest\b|\bimplement\b|\bbuild\b|\brepair\b|\bpatch\b|\bcode\b|\bbug\b/i;
const DIRECTOR_OWNED = /\bplan\b|\bassign\b|\bcoordinate\b|\bschedule\b|\btriage\b/i;

export function ownerRoleFor(text: string): "worker" | "director" {
  if (WORKER_OWNED.test(text)) return "worker";
  if (DIRECTOR_OWNED.test(text)) return "director";
  return "worker";
}

export type RouteInput = {
  seat: string;
  role: SeatRole;
  bead: string;
  text: string;
  /** True when the runner would do the work itself rather than route it. */
  selfDo?: boolean;
  /** Joshua's quoted words authorizing a self-do. Required when selfDo is true. */
  roleOverride?: string;
  /** Fallback seat names when the roster names no target. */
  directorSeat?: string;
  workerSeat?: string;
};

export type RouteVerdict =
  | { action: "DO"; bead: string; reply: string }
  | { action: "ROUTE"; bead: string; seat: string; reply: string }
  | { action: "REFUSE"; reason: string; reply: string };

/** Find a roster seat holding a role, for ROUTE targets. Null when none. */
export function rosterSeatWithRole(config: unknown, role: SeatRole): string | null {
  if (typeof config !== "object" || config === null) return null;
  const record = config as Record<string, unknown>;
  for (const key of ["roster", "seats", "seatRoles", "seat_roles"]) {
    const map = record[key];
    if (typeof map === "object" && map !== null) {
      for (const [name, value] of Object.entries(map as Record<string, unknown>)) {
        if (canonRole(value) === role) return name;
      }
    }
  }
  return null;
}

export function routeIntake(input: RouteInput, config?: unknown): RouteVerdict {
  const bead = input.bead.trim();
  const text = input.text.trim();
  if (bead === "" || text === "") {
    return { action: "REFUSE", reason: "EMPTY_INPUT", reply: "Refused: bead and request text are both required." };
  }
  if (input.role === "UNKNOWN") {
    return { action: "REFUSE", reason: "UNKNOWN_ROLE", reply: `Refused: seat ${input.seat} has no roster role; no routing without a known role.` };
  }
  // Doing it yourself without his words is refused unless Joshua's quote is cited.
  if (input.selfDo === true && (input.roleOverride ?? "").trim() === "") {
    return {
      action: "REFUSE",
      reason: "SELF_DO_WITHOUT_WORDS",
      reply: "Refused: doing it yourself needs Joshua's words; cite them with --role-override '<joshua quote>'.",
    };
  }
  const owner = ownerRoleFor(text);
  if (input.role === owner) {
    return { action: "DO", bead, reply: `Doing ${bead}: ${text}` };
  }
  // Role-foreign work routes down one rung: chief -> project director, director -> worker.
  let target: string;
  if (input.role === "lead-chief" || input.role === "peer-chief") {
    target = (config !== undefined ? rosterSeatWithRole(config, "director") : null) ?? input.directorSeat ?? "project-director";
  } else {
    target = (config !== undefined ? rosterSeatWithRole(config, "worker") : null) ?? input.workerSeat ?? "worker";
  }
  return { action: "ROUTE", bead, seat: target, reply: `Routing ${bead} to ${target}: ${text}` };
}

/** stdout print: first line machine route, second line one-line reply. */
export function formatRoute(verdict: RouteVerdict): string {
  const first =
    verdict.action === "DO"
      ? `DO ${verdict.bead}`
      : verdict.action === "ROUTE"
        ? `ROUTE ${verdict.bead} -> ${verdict.seat}`
        : `REFUSE ${verdict.reason}`;
  return `${first}\n${verdict.reply}`;
}

/** --json mirror of the print format. */
export function routeToJson(verdict: RouteVerdict): Record<string, unknown> {
  if (verdict.action === "DO") return { action: "DO", bead: verdict.bead, reply: verdict.reply };
  if (verdict.action === "ROUTE") return { action: "ROUTE", bead: verdict.bead, seat: verdict.seat, reply: verdict.reply };
  return { action: "REFUSE", reason: verdict.reason, reply: verdict.reply };
}
