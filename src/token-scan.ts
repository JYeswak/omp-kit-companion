/** TOKENSCAN1: bounded credential scan for CC11 stores and captured output.
 *
 * The scanner is deliberately screen-injected: the CC0 generated registry/HMAC
 * screen is the only production authority.  A missing screen is UNKNOWN, never
 * clean.  Findings contain area/path/offset only; matched bytes never enter a
 * receipt or error string.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

export type TokenScreen = (text: string) => string | null;
export type ScanArea = "producer-temp" | "spool" | "gzip" | "db" | "wal" | "backup" | "api" | "sse";
export type TokenFinding = Readonly<{ area: ScanArea; path: string; offset: number; code: string }>;
export type TokenScanResult = Readonly<{ overall: "GREEN" | "RED" | "UNKNOWN"; hits: readonly TokenFinding[]; files: number; registry_sha256: string | null; screen: "clean" | "hit" | "unavailable" }>;

export function scanTokenBytes(path: string, area: ScanArea, bytes: Uint8Array, screen: TokenScreen | null): TokenFinding | null {
  if (!screen) return null;
  const text = Buffer.from(bytes).toString("utf8");
  let offset = 0;
  for (const line of text.split("\n")) {
    const code = screen(line);
    if (code) return { area, path: safePath(path), offset, code };
    offset += Buffer.byteLength(line, "utf8") + 1;
  }
  return null;
}

export function scanTokenFile(path: string, area: ScanArea, screen: TokenScreen | null): TokenFinding | null {
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch { return null; }
  return scanTokenBytes(path, area, bytes, screen);
}

export function scanTokenFiles(inputs: readonly { path: string; area: ScanArea; gzip?: boolean }[], screen: TokenScreen | null, registryBytes?: Uint8Array): TokenScanResult {
  if (!screen) return { overall: "UNKNOWN", hits: [], files: 0, registry_sha256: registryBytes ? createHash("sha256").update(registryBytes).digest("hex") : null, screen: "unavailable" };
  const hits: TokenFinding[] = [];
  let files = 0;
  let unreadable = false;
  for (const input of inputs) {
    try {
      const raw = readFileSync(input.path);
      const bytes = input.gzip ? gunzipSync(raw) : raw;
      files++;
      const hit = scanTokenBytes(input.path, input.area, bytes, screen);
      if (hit) hits.push(hit);
    } catch {
      // An unreadable store cannot be certified clean.
      unreadable = true;
    }
  }
  return {
    overall: hits.length ? "RED" : unreadable ? "UNKNOWN" : "GREEN",
    hits,
    files,
    registry_sha256: registryBytes ? createHash("sha256").update(registryBytes).digest("hex") : null,
    screen: hits.length ? "hit" : "clean",
  };
}

function safePath(path: string): string {
  return path.replace(/\\/g, "/");
}
