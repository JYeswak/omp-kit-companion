const CAPTURE_BIN = "/Users/josh/.local/bin/zestgraph-ee-capture";
const CAPTURE_TIMEOUT_MS = 9_500;
const MAX_FIELD_CHARS = 16_384;

type JsonRecord = Record<string, unknown>;

type GlobalState = typeof globalThis & {
  __zeststream_omp_ee_failure_journal_seen_v1?: Set<string>;
};

export type OmpToolResultEvent = {
  type?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  input?: unknown;
  details?: unknown;
  isError?: unknown;
  content?: unknown;
};

type CapturePayload = {
  hook_event_name: "PostToolUse";
  tool_name: "Bash";
  tool_input: { command: string };
  tool_response: { exit_code: number; stderr_tail: string };
  cwd: string;
};

export type SpawnedProcess = {
  stdin: { write: (text: string) => unknown; end: () => unknown };
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
};

type SpawnOptions = {
  cwd: string;
  stdin: "pipe";
  stdout: "ignore";
  stderr: "pipe";
};
export type SpawnProcess = (argv: string[], options: SpawnOptions) => SpawnedProcess;

type AdapterOptions = {
  spawn?: SpawnProcess;
  seen?: Set<string>;
};

type OmpExtensionApi = {
  on: (event: "tool_result", handler: (event: OmpToolResultEvent, ctx: { cwd: string }) => unknown) => void;
};

function asRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseExitCode(details: unknown): number | undefined {
  const detail = asRecord(details);
  const value = detail?.exitCode;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
  return value;
}

function globalSeen(): Set<string> {
  const state = globalThis as GlobalState;
  return (state.__zeststream_omp_ee_failure_journal_seen_v1 ??= new Set<string>());
}

function spawnCapture(argv: string[], options: SpawnOptions): SpawnedProcess {
  return Bun.spawn(argv, options) as unknown as SpawnedProcess;
}

function failureText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let output = "";
  for (const item of content) {
    const record = asRecord(item);
    const separator = output ? "\n" : "";
    if (output.length + separator.length + record.text.length > MAX_FIELD_CHARS) {
      return "[OMP tool output over capture limit]";
    }
    output += separator + record.text;
  }
  return output;
}

function capturePayload(event: OmpToolResultEvent, code: number, cwd: string): CapturePayload {
  const input = asRecord(event.input);
  const command = typeof input?.command === "string" && input.command.length <= MAX_FIELD_CHARS
    ? input.command
    : "";
  return {
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { exit_code: code, stderr_tail: failureText(event.content) },
    cwd,
  };
}

async function invokeCapture(payload: CapturePayload, spawn: SpawnProcess): Promise<boolean> {
  const child = spawn([CAPTURE_BIN], {
    cwd: payload.cwd,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
  });
  try {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    child.stdin.end();
  } catch {
    child.kill();
    return false;
  }
  const completed = Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]).then(([code]) => code === 0).catch(() => false);
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>(resolve => {
    timeout = setTimeout(() => {
      try { child.kill(); } catch { /* Capture is advisory. */ }
      resolve(false);
    }, CAPTURE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([completed, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

export function createBashFailureJournalAdapter(options: AdapterOptions = {}) {
  const spawn = options.spawn ?? spawnCapture;
  const seen = options.seen ?? globalSeen();

  async function handle(event: OmpToolResultEvent, ctx?: { cwd: string }): Promise<void> {
    if (event?.type !== "tool_result" || event.toolName !== "bash") return;
    const toolCallId = nonEmptyString(event.toolCallId);
    const code = parseExitCode(event.details);
    if (!toolCallId || !asRecord(event.input) || code === undefined || code === 0) return;

    const key = `bash:${toolCallId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const payload = capturePayload(event, code, ctx?.cwd || process.cwd());
    try {
      if (!(await invokeCapture(payload, spawn))) {
        seen.delete(key);
        console.error("EE_CAPTURE_UNKNOWN: OMP capture did not complete");
      }
    } catch {
      seen.delete(key);
      console.error("EE_CAPTURE_UNKNOWN: OMP capture could not start");
    }
  }

  return { handle };
}

/** Observe failed Bash results without changing their outcome. */
export default function eeFailureJournalExtension(pi: OmpExtensionApi): void {
  const adapter = createBashFailureJournalAdapter();
  pi.on("tool_result", (event, ctx) => adapter.handle(event, ctx));
}
