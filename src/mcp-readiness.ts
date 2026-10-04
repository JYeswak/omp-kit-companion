import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { YAML } from "bun";

export interface McpReadinessInput {
 home: string;
 profile: string;
 project?: string;
 /** Installed OMP launcher for source-backed discovery semantics (optional). */
 ompPath?: string;
 pathEnv?: string;
}
export interface McpServerReadiness {
 name: string;
 configured: boolean;
 discoverable: "CANDIDATE" | "BLOCKED" | "UNVERIFIED";
 executable_found: boolean;
 startup_ready: "NOT_PROBED";
 actually_callable: "NOT_PROBED";
 reason: string;
 recommended_action: string;
}
export interface McpReadinessReport {
 status: "DEGRADED" | "UNVERIFIED";
 profile: string;
 servers: McpServerReadiness[];
 reason: string;
 recommended_action: string;
 /** Inventory never launches configured commands; connection and call require isolated opt-in proof. */
 proof: "ON_DISK_INVENTORY_ONLY";
}

const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SERVER_NAME = /^[a-zA-Z0-9_.-]{1,100}$/;
const MAX_CONFIG_BYTES = 1024 * 1024;
const NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function state(path: string): "missing" | "file" | "directory" | "unsafe" {
 try { const s = lstatSync(path); return s.isDirectory() ? "directory" : s.isFile() ? "file" : "unsafe"; }
 catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe"; }
}
function safeDirectory(root: string, segments: readonly string[]): boolean {
 if (!isAbsolute(root) || state(root) !== "directory") return false;
 let path = root;
 for (const segment of segments) { path = join(path, segment); if (state(path) !== "directory") return false; }
 return true;
}
function readConfig(path: string): string {
 const fd = openSync(path, NOFOLLOW);
 try {
  const s = fstatSync(fd);
  if (!s.isFile() || s.size > MAX_CONFIG_BYTES) throw new Error("unsafe or oversized config");
  return readFileSync(fd, "utf8");
 } finally { closeSync(fd); }
}
function report(profile: string, status: "DEGRADED" | "UNVERIFIED", reason: string, action: string, servers: McpServerReadiness[] = []): McpReadinessReport {
 return { status, profile, servers, reason, recommended_action: action, proof: "ON_DISK_INVENTORY_ONLY" };
}
function executable(command: string, pathEnv: string): boolean {
 // Relative paths and unresolved interpolations can depend on OMP cwd/env; never execute or guess.
 if (!command || command.includes("${") || (command.includes("/") && !isAbsolute(command))) return false;
 const paths = isAbsolute(command) ? [command] : pathEnv.split(delimiter).filter(isAbsolute).map(dir => join(dir, command));
 for (const path of paths) {
  try {
   const real = realpathSync(path);
   const stat = lstatSync(real);
   if (stat.isFile() && (stat.mode & 0o111) !== 0) return true;
  } catch { /* Not present or inaccessible. */ }
 }
 return false;
}
function sourceBacked(path?: string): boolean {
 if (!path) return false;
 try {
  const root = dirname(dirname(realpathSync(path)));
  const meta: unknown = JSON.parse(readConfig(join(root, "package.json")));
  // Newer/older OMP versions may load providers differently; don't infer semantics from them.
  return record(meta) && meta.name === "@oh-my-pi/pi-coding-agent" && meta.version === "18.4.2" && state(join(root, "src", "discovery", "builtin.ts")) === "file" && state(join(root, "src", "mcp", "config.ts")) === "file";
 } catch { return false; }
}
function inspectSettings(agent: string): { disabled: boolean; issue: boolean } {
 const files = ["config.yml", "config.yaml", "config.json", "settings.json"].filter(name => state(join(agent, name)) !== "missing");
 if (files.length > 1 || files.some(name => !name.endsWith(".yml") && !name.endsWith(".yaml"))) return { disabled: false, issue: true };
 if (files.length === 0) return { disabled: false, issue: true }; // Effective defaults/migration cannot be inferred.
 try {
  const value: unknown = YAML.parse(readConfig(join(agent, files[0]!)));
  if (!record(value) || (value.disabledProviders !== undefined && (!Array.isArray(value.disabledProviders) || !value.disabledProviders.every(v => typeof v === "string")))) return { disabled: false, issue: true };
  return { disabled: (value.disabledProviders as string[] | undefined)?.includes("native") ?? false, issue: false };
 } catch { return { disabled: false, issue: true }; }
}
function projectShadow(project: string | undefined, name: string): "none" | "shadow" | "opaque" {
 if (!project) return "none";
 const cwd = resolve(project);
 if (state(cwd) !== "directory") return "opaque";
 for (const segments of [[".omp", "mcp.json"], [".omp", ".mcp.json"], ["mcp.json"], [".mcp.json"]]) {
  const parent = segments.length === 1 ? cwd : join(cwd, segments[0]!);
  if (state(parent) === "missing") continue;
  if (state(parent) !== "directory") return "opaque";
  const path = join(cwd, ...segments);
  if (state(path) === "missing") continue;
  try {
   const parsed: unknown = JSON.parse(readConfig(path));
   if (!record(parsed) || !record(parsed.mcpServers)) return "opaque";
   if (Object.hasOwn(parsed.mcpServers, name)) return "shadow";
  } catch { return "opaque"; }
 }
 // Foreign and extension discovery sources can also win; never assert effective discovery here.
 return "none";
}

/** No OMP invocation, migration, user writes, subprocesses, server startup, or env-value exposure. */
export function inspectMcpReadiness(input: McpReadinessInput): McpReadinessReport {
 const name = input.profile;
 if (!PROFILE_NAME.test(name) || name === "default" || name === "." || name === ".." || name.endsWith(".")) return report(name, "DEGRADED", "A named existing profile is required", "Select a named OMP profile; the default profile is not inspected by this optional command.");
 const home = resolve(input.home);
 const segments = [".omp", "profiles", name, "agent"];
 if (!safeDirectory(home, segments)) return report(name, "DEGRADED", "Named profile removed, absent, or unsafe", "Select an existing named profile; inspection never creates one.");
 const agent = join(home, ...segments);
 const filenames = ["mcp.json", ".mcp.json"];
 const files = filenames.filter(file => state(join(agent, file)) !== "missing");
 if (!files.length) return report(name, "DEGRADED", "No native MCP config in selected profile", `List importable servers with omp-kit doctor --scope mcp --sources, then omp-kit apply mcp --from SOURCE --servers NAMES --profiles ${name} --plan.`);
 const entries = new Map<string, { command: string; enabled: boolean; duplicate: boolean; invalid: boolean }>();
 const denied = new Set<string>();
 try {
  for (const file of files) {
   const parsed: unknown = JSON.parse(readConfig(join(agent, file)));
   if (!record(parsed) || !record(parsed.mcpServers)) throw new Error("malformed");
   if (parsed.disabledServers !== undefined) {
    if (!Array.isArray(parsed.disabledServers) || !parsed.disabledServers.every(value => typeof value === "string")) throw new Error("malformed");
    for (const serverName of parsed.disabledServers) denied.add(serverName);
   }
   for (const [serverName, value] of Object.entries(parsed.mcpServers)) {
    const previous = entries.get(serverName);
    if (!SERVER_NAME.test(serverName)) throw new Error("malformed");
    const valid = record(value) && typeof value.command === "string" && value.command.length > 0 && (value.type === undefined || value.type === "stdio") && (value.args === undefined || Array.isArray(value.args) && value.args.every(arg => typeof arg === "string")) && (value.env === undefined || record(value.env) && Object.values(value.env).every(item => typeof item === "string")) && (value.enabled === undefined || typeof value.enabled === "boolean" || typeof value.enabled === "string" && /^(?:true|false|0|1)$/i.test(value.enabled));
    const normalized = valid && typeof value.enabled === "string" ? value.enabled.toLowerCase() : value.enabled;
    const enabled = valid && normalized !== false && normalized !== "false" && normalized !== "0";
    entries.set(serverName, { command: valid ? value.command as string : "", enabled, duplicate: Boolean(previous), invalid: !valid });
   }
  }
 } catch { return report(name, "UNVERIFIED", "Selected profile has malformed or unsafe mcp.json", "Correct the named profile MCP file before checking it again."); }
 const settings = inspectSettings(agent);
 const backed = sourceBacked(input.ompPath);
 const servers = [...entries].sort(([a], [b]) => a.localeCompare(b)).map(([serverName, config]): McpServerReadiness => {
  const found = config.command ? executable(config.command, input.pathEnv ?? process.env.PATH ?? "") : false;
  const shadow = projectShadow(input.project, serverName);
  const issue = config.duplicate ? "duplicate server name in profile MCP files" : config.invalid ? "invalid stdio server configuration" : denied.has(serverName) ? "server disabled by profile MCP denylist" : !config.enabled ? "server disabled in profile" : settings.disabled ? "native MCP discovery provider disabled in selected profile" : !found ? "configured executable absent or unresolved" : shadow === "shadow" ? "project MCP server overrides selected profile" : shadow === "opaque" ? "project MCP config cannot be resolved safely" : settings.issue ? "effective profile settings unverified" : !backed ? "installed OMP MCP discovery semantics unverified" : "native MCP config is a discovery candidate, not a connected or callable tool";
  const blocked = config.duplicate || config.invalid || denied.has(serverName) || !config.enabled || settings.disabled || !found || shadow === "shadow";
  return { name: serverName, configured: true, discoverable: blocked ? "BLOCKED" : shadow === "opaque" || settings.issue || !backed ? "UNVERIFIED" : "CANDIDATE", executable_found: found, startup_ready: "NOT_PROBED", actually_callable: "NOT_PROBED", reason: issue, recommended_action: blocked || shadow === "opaque" ? "Resolve the named profile/provider/project conflict; never run untrusted configured commands as a diagnostic." : `Prove startup and one call through OMP with omp-kit test --mcp --profiles ${name} --servers ${serverName} --call ${serverName}:TOOL:JSON.` };
 });
 return report(name, servers.some(server => server.discoverable === "BLOCKED") ? "DEGRADED" : "UNVERIFIED", "Read-only on-disk MCP inventory; no server was started or called", `Prove each server callable with omp-kit test --mcp --profiles ${name}; import more with omp-kit apply mcp --from SOURCE --servers NAMES --profiles ${name} --plan.`, servers);
}

/** Static, credential-free manual template. No defaults, installation, or config mutation. */
export function mcpExample(): string {
 return [
  "Optional existing local MCP executable; edit YOUR_EXISTING_MCP_EXECUTABLE yourself.",
  "In the selected existing named profile's ~/.omp/profiles/NAME/agent/mcp.json:",
  '{"mcpServers":{"local-example":{"type":"stdio","command":"YOUR_EXISTING_MCP_EXECUTABLE","args":[]}}}',
  "Nothing is enabled on the default profile or in a project by omp-kit.",
  "Run omp-kit doctor --scope mcp --profile NAME --json for on-disk inventory only.",
  "configured/discoverable are not startup-ready or callable; both remain NOT_PROBED until an isolated OMP-mediated call.",
  "Agent Mail is one optional existing local MCP example, not a bundled daemon or credential.",
 ].join("\n");
}
