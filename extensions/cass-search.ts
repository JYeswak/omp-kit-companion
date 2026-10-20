import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CASS = "/Users/josh/.local/bin/cass";
// The host's ONE archive is declared in ~/.config/cass/canonical-data-dir (last non-comment line),
// the same file cass-canonical-env reads; a literal here once pinned this tool to a frozen archive.
const DECLARED = join(homedir(), ".config", "cass", "canonical-data-dir");
const TIMEOUT_MS = 20_000;

function dataDir(): string {
  const line = readFileSync(DECLARED, "utf8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#")).pop();
  if (!line || !line.startsWith("/")) throw new Error(`CASS archive not declared in ${DECLARED}`);
  if (!existsSync(join(line, "agent_search.db"))) throw new Error(`Declared CASS archive has no agent_search.db: ${line}`);
  return line;
}

type SearchResult = {
  query: string;
  count: number;
  total_matches: number;
  hits: unknown[];
  budget?: { timed_out?: boolean };
};

export default function cassSearch(pi: ExtensionAPI): void {
  const z = pi.zod;
  pi.registerTool({
    name: "cass_search",
    label: "Search prior agent sessions",
    description: "Search indexed local coding-agent conversations for prior decisions and working commands. Read-only; cite source_path and line_number, and verify important claims against current files. Use a specific query. No automatic search on every turn.",
    approval: "read",
    parameters: z.object({
      query: z.string().min(2).max(300).describe("Specific words or phrase to locate in past sessions"),
      limit: z.number().int().min(1).max(5).optional().describe("Maximum hits, 1–5; default 3"),
    }),
    async execute(_id, { query, limit = 3 }, signal) {
      const args = [CASS, "search", query, "--mode", "lexical", "--no-maintenance", "--data-dir", dataDir(),
        "--limit", String(limit), "--json", "--max-content-length", "1200", "--max-tokens", "1800", "--timeout", String(TIMEOUT_MS)];
      const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const stop = () => child.kill();
      signal?.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, TIMEOUT_MS + 1000);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        if (signal?.aborted) throw new Error("CASS search cancelled");
        if (code !== 0) throw new Error(`CASS search failed (${code}): ${stderr.slice(0, 300)}`);
        const result = JSON.parse(stdout) as SearchResult;
        if (!Array.isArray(result.hits) || result.budget?.timed_out) throw new Error("CASS search incomplete");
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { count: result.count } };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
      }
    },
  });
}
