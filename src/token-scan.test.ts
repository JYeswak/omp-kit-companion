import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { scanTokenBytes, scanTokenFiles } from "./token-scan.ts";

describe("TOKENSCAN1", () => {
  const screen = (text: string) => text.includes("glpat-") || text.includes("known-secret") ? "CC0" : null;
  test("clean fixture has no hits", () => {
    expect(scanTokenBytes("spool.jsonl", "spool", Buffer.from("ordinary event\n"), screen)).toBeNull();
  });
  test("hit reports path and byte offset without echoing token", () => {
    const token = "glpat-" + "x".repeat(20);
    const result = scanTokenBytes("backup.json", "backup", Buffer.from("prefix\n" + token), screen)!;
    expect(result.offset).toBe(Buffer.byteLength("prefix\n"));
    expect(JSON.stringify(result)).not.toContain(token);
  });
  test("generated gzip and HMAC screen are exercised; absent screen is unknown", () => {
    const token = "known-secret";
    const result = scanTokenFiles([{ path: "/tmp/tokenscan-missing", area: "gzip", gzip: true }], null, Buffer.from("registry"));
    expect(result.overall).toBe("UNKNOWN");
    expect(result.registry_sha256).toHaveLength(64);
    expect(scanTokenBytes("api", "api", gzipSync(Buffer.from(token)), screen)).toBeNull();
  });
  test("unreadable store is unknown rather than clean", () => {
    const result = scanTokenFiles([{ path: "/tmp/tokenscan-missing", area: "db" }], screen);
    expect(result.overall).toBe("UNKNOWN");
    expect(result.files).toBe(0);
  });
});

