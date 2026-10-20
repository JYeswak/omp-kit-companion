/**
 * OMP v18 observational tool-result adapter draft.
 *
 * Scope is deliberately limited to:
 *   - successful OMP write/edit results -> one capture record
 *   - non-zero OMP bash results -> one failure record
 *
 * It never invokes a shell and never handles pre-tool/blocking behavior.
 */

type JsonRecord = Record<string, unknown>;

type ToolResultEvent = {
  type?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  input?: unknown;
  content?: unknown;
  details?: unknown;
  isError?: unknown;
};

type AdapterContext = { cwd?: unknown } | undefined;

type CaptureRecord = {
  kind: "successful_tool_result";
  toolName: string;
  toolCallId: string;
  paths: string[];
  cwd?: string;
};

type FailureRecord = {
  kind: "bash_failure";
  toolName: "bash";
  toolCallId: string;
  exitCode: number;
  command?: string;
  cwd?: string;
};

type ObservationalSinks = {
  capture?: (record: CaptureRecord) => void | Promise<void>;
  failure?: (record: FailureRecord) => void | Promise<void>;
};

type OmpExtensionApi = {
  on: (event: "tool_result", handler: (event: ToolResultEvent, ctx: AdapterContext) => unknown) => void;
  appendEntry: (customType: string, data: JsonRecord) => void | Promise<void>;
};

const CAPTURE_TOOL_NAMES: Record<string, true> = {
  write: true,
  edit: true,
  apply_patch: true,
};
const MAX_COMMAND_CHARS = 4_000;
const HASHLINE_PATH = /^¶+(.+?)(?:#[0-9a-fA-F]{4})?$/u;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function uniqueStrings(values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === "") continue;
    const path = value.trim();
    if (!result.includes(path)) result.push(path);
  }
  return result;
}

function hashlinePaths(raw: string): string[] {
  const paths: string[] = [];
  for (const line of raw.split("\n")) {
    const match = HASHLINE_PATH.exec(line.trimStart());
    if (!match) continue;
    const path = match[1].trim();
    if (path !== "" && !path.includes("\u0000")) paths.push(path);
  }
  return uniqueStrings(paths);
}

function targetPaths(toolName: string, input: JsonRecord): string[] {
  const direct = typeof input.path === "string" ? [input.path] : [];
  const many = Array.isArray(input.paths) ? input.paths : [];
  const paths = uniqueStrings([...direct, ...many]);
  if (paths.length > 0 || toolName === "write") return paths;

  const raw = typeof input.input === "string" ? input.input : undefined;
  return raw === undefined ? [] : hashlinePaths(raw);
}

function exitCode(details: unknown): number | undefined {
  const d = record(details);
  if (!d) return undefined;
  const value = d.exitCode;
  if (typeof value === "number" && Number.isInteger(value) && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function contextCwd(ctx: AdapterContext): string | undefined {
  return nonEmptyString(ctx?.cwd);
}

export function createObservationalAdapter(sinks: ObservationalSinks = {}) {
  const seen = new Set<string>();

  async function once(key: string, action: () => void | Promise<void>): Promise<boolean> {
    if (seen.has(key)) return false;
    seen.add(key);
    try {
      await action();
      return true;
    } catch (error) {
      seen.delete(key);
      throw error;
    }
  }

  async function handle(event: ToolResultEvent, ctx?: AdapterContext): Promise<"captured" | "journaled" | "ignored"> {
    const e = record(event);
    if (!e || event.type !== "tool_result") return "ignored";

    const toolName = nonEmptyString(event.toolName);
    const toolCallId = nonEmptyString(event.toolCallId);
    const input = record(event.input);
    if (!toolName || !toolCallId || !input) return "ignored";

    if (CAPTURE_TOOL_NAMES[toolName] === true) {
      if (event.isError === true || !Array.isArray(event.content)) return "ignored";
      const paths = targetPaths(toolName, input);
      if (paths.length === 0) return "ignored";

      const capture: CaptureRecord = {
        kind: "successful_tool_result",
        toolName,
        toolCallId,
        paths,
        ...(contextCwd(ctx) ? { cwd: contextCwd(ctx) } : {}),
      };
      const accepted = await once(`capture:${toolCallId}`, async () => {
        await sinks.capture?.(capture);
      });
      return accepted ? "captured" : "ignored";
    }

    if (toolName !== "bash") return "ignored";
    const code = exitCode(event.details);
    if (code === undefined || code === 0) return "ignored";

    const command = typeof input.command === "string" ? input.command.slice(0, MAX_COMMAND_CHARS) : undefined;
    const failure: FailureRecord = {
      kind: "bash_failure",
      toolName: "bash",
      toolCallId,
      exitCode: code,
      ...(command ? { command } : {}),
      ...(contextCwd(ctx) ? { cwd: contextCwd(ctx) } : {}),
    };
    const accepted = await once(`failure:${toolCallId}`, async () => {
      await sinks.failure?.(failure);
    });
    return accepted ? "journaled" : "ignored";
  }

  return { handle };
}

/**
 * OMP extension factory. This draft records structured session entries only;
 * it does not call ee, spawn a process, or install any manifest wiring.
 */
export default function observationalToolResultAdapter(pi: OmpExtensionApi): void {
  const adapter = createObservationalAdapter({
    capture: (data) => pi.appendEntry("com.zeststream.omp-observational-hook.capture.v1", data),
    failure: (data) => pi.appendEntry("com.zeststream.omp-observational-hook.failure.v1", data),
  });

  pi.on("tool_result", async (event, ctx) => {
    try {
      await adapter.handle(event, ctx);
    } catch {
      // Observation must not change the already-completed tool result.
    }
  });
}
