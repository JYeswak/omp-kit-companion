import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convergeCommand, convergeRepository, type ConvergeOptions, type ConvergeResult } from "../../src/converge.ts";

const root = resolve(import.meta.dir, "../.."), scratchRoot = join(root, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, `converge.${process.pid}.`));
writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=converge\nrepo=${root}\ncreated=${new Date().toISOString()}\n`);
const realGit = Bun.which("git");
if (!realGit) throw new Error("Git is required for converge integration tests");
const cleanEnv: NodeJS.ProcessEnv = {};
for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) cleanEnv[key] = value;
cleanEnv.GIT_TERMINAL_PROMPT = "0";
cleanEnv.TMPDIR = scratch;
let number = 0;
type World = { bare: string; a: string; b: string; dir: string };
function git(repo: string, ...args: string[]): string {
	const p = spawnSync(realGit, ["-C", repo, ...args], { env: cleanEnv, encoding: "utf8" });
	if (p.status !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
	return p.stdout.trim();
}
function put(repo: string, path: string, value: string): void { writeFileSync(join(repo, path), value); }
function read(repo: string, path: string): string | null { return existsSync(join(repo, path)) ? readFileSync(join(repo, path), "utf8") : null; }
function local(repo: string, path: string, value: string, message = "local"): void { put(repo, path, value); git(repo, "commit", "-q", "--only", "-m", message, "--", path); }
function remote(w: World, path: string, value: string): void { put(w.b, path, value); git(w.b, "add", "--", path); git(w.b, "commit", "-q", "-m", `remote ${path}`); git(w.b, "push", "-q", "origin", "main"); }
function world(): World {
	const dir = join(scratch, String(number++)); mkdirSync(dir);
	const w = { dir, bare: join(dir, "origin.git"), a: join(dir, "a"), b: join(dir, "b") };
	git(dir, "init", "-q", "--bare", "-b", "main", w.bare);
	git(dir, "clone", "-q", w.bare, w.a);
	for (const path of ["f1", "f2", "f3", "f4", "gone"]) put(w.a, path, `${path} v0\n`);
	git(w.a, "config", "user.name", "converge test"); git(w.a, "config", "user.email", "converge@example.invalid"); git(w.a, "config", "core.hooksPath", "/dev/null");
	git(w.a, "add", "."); git(w.a, "commit", "-q", "-m", "base"); git(w.a, "push", "-q", "origin", "main");
	git(dir, "clone", "-q", w.bare, w.b);
	git(w.b, "config", "user.name", "converge test"); git(w.b, "config", "user.email", "converge@example.invalid"); git(w.b, "config", "core.hooksPath", "/dev/null");
	return w;
}
function state(repo: string) { return [git(repo, "rev-parse", "HEAD"), git(repo, "ls-files", "-s"), git(repo, "status", "--porcelain=v1", "-uall")]; }
function apply(w: World, more: Partial<ConvergeOptions> = {}) { return convergeRepository({ repo: w.a, apply: true, ...more }); }
function diverged(): World { const w = world(); local(w.a, "f1", "mine\n"); remote(w, "f1", "theirs\n"); return w; }
function hinted(oursLonger: boolean): World {
	const w = world(); local(w.a, "f1", "v1\n"); local(w.a, "f3", "local f3\n"); remote(w, "f1", "v1\n");
	if (oursLonger) { local(w.a, "f1", "v2\n"); remote(w, "f2", "remote f2\n"); } else remote(w, "f1", "v2\n");
	return w;
}
/** Process-local command boundary fault injection: all Git operations and state are real.
 * No production hooks, module mocks, global PATH or global Git environment mutation.
 */
function raced(w: World, when: "after_hash" | "before_ref" | "before_push" | "before_write", action: string, once = true, options: Partial<ConvergeOptions> = {}): ConvergeResult {
	const bin = join(w.dir, "bin"); mkdirSync(bin);
	const marker = join(w.dir, "calls"), wrapper = join(bin, "git");
	writeFileSync(wrapper, `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,renameSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
const real=${JSON.stringify(realGit)}, a=${JSON.stringify(w.a)}, b=${JSON.stringify(w.b)}, bare=${JSON.stringify(w.bare)}, marker=${JSON.stringify(marker)};
const args=process.argv.slice(2), command=args[2];
const env={...process.env}; for(const k of Object.keys(env)) if(k.startsWith('GIT_')) delete env[k]; env.GIT_TERMINAL_PROMPT='0';
function g(repo,...argv){const p=spawnSync(real,['-C',repo,...argv],{env,encoding:'utf8'}); if(p.status!==0) throw new Error(p.stderr);return p.stdout.trim();}
function put(repo,path,bytes){writeFileSync(join(repo,path),bytes);}
function local(repo,path,bytes,message='peer commit'){put(repo,path,bytes);g(repo,'commit','-q','--only','-m',message,'--',path);}
function remote(path,bytes){put(b,path,bytes);g(b,'add','--',path);g(b,'commit','-q','-m','remote race');g(b,'push','-q','origin','main');}
const trigger=command===${JSON.stringify(when === "after_hash" ? "hash-object" : when === "before_ref" ? "update-ref" : when === "before_write" ? "cat-file" : "push")} && (command!=='update-ref'||args.includes('refs/heads/main')) && (command!=='cat-file'||args.includes('--filters')) && (command!=='hash-object'||args.includes('--'));
function action(){let n=existsSync(marker)?Number(readFileSync(marker,'utf8')):0;if(${once}&&n>0)return;writeFileSync(marker,String(n+1));${action}}
if(trigger&&${JSON.stringify(when)}!=='after_hash')action();
const p=spawnSync(real,args,{env:process.env,input:readFileSync(0)});
if(trigger&&${JSON.stringify(when)}==='after_hash')action();
process.stdout.write(p.stdout??'');process.stderr.write(p.stderr??'');process.exit(p.status??1);
`);
	chmodSync(wrapper, 0o755);
	const code = `import {convergeRepository} from ${JSON.stringify(join(root, "src/converge.ts"))}; console.log(JSON.stringify(convergeRepository(JSON.parse(process.argv[1]))));`;
	const p = spawnSync(process.execPath, ["-e", code, JSON.stringify({ repo: w.a, apply: true, ...options })], { env: { ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH}` }, encoding: "utf8", timeout: 30_000 });
	if (p.status !== 0) throw new Error(`converge child failed: ${p.stdout}\n${p.stderr}`);
	return JSON.parse(p.stdout) as ConvergeResult;
}
afterAll(() => { for (let i = 0; i < number; i++) rmSync(join(scratch, String(i)), { recursive: true, force: true }); });

test("T1 ahead-only publishes shared main", () => { const w = world(); local(w.a, "f1", "local\n"); const r = apply(w, { push: true }); expect(r.state).toBe("AHEAD"); expect(r.pushed).toBe(true); expect(git(w.bare, "rev-parse", "main")).toBe(git(w.a, "rev-parse", "main")); });
for (const check of ["two parents", "origin index and worktree", "peer staging", "peer dirty", "local history"] as const) test(`T2 diverged merge preserves ${check}`, () => {
	const w = world(); remote(w, "f2", "remote\n"); local(w.a, "f1", "local\n"); put(w.a, "f3", "staged\n"); git(w.a, "add", "f3"); put(w.a, "f4", "dirty\n"); const entry = git(w.a, "ls-files", "-s", "--", "f3"), old = git(w.a, "rev-parse", "HEAD");
	const r = apply(w); expect(r.state).toBe("MERGED");
	switch (check) {
		case "two parents": expect(git(w.a, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3); break;
		case "origin index and worktree": expect(read(w.a, "f2")).toBe("remote\n"); expect(git(w.a, "diff", "HEAD", "--", "f2")).toBe(""); expect(r.index_updated).toBe(1); break;
		case "peer staging": expect(git(w.a, "ls-files", "-s", "--", "f3")).toBe(entry); expect(git(w.a, "diff", "--cached", "--name-only")).toBe("f3"); break;
		case "peer dirty": expect(read(w.a, "f4")).toBe("dirty\n"); break;
		case "local history": expect(read(w.a, "f1")).toBe("local\n"); expect(git(w.a, "merge-base", "--is-ancestor", old, "HEAD")).toBe(""); break;
	}
});
for (const staged of [false, true]) test(staged ? "T4 staged overlap refuses without mutation" : "T3 dirty overlap refuses without mutation", () => {
	const w = world(); remote(w, "f1", "remote\n"); put(w.a, "f1", "peer\n");
	if (staged) { git(w.a, "add", "f1"); put(w.a, "f1", "f1 v0\n"); }
	const before = state(w.a); const r = apply(w);
	expect(r.state).toBe("REFUSED"); expect(r.conflicts).toContainEqual({ path: "f1", kind: staged ? "STAGED_OVERLAP" : "DIRTY_OVERLAP" }); expect(state(w.a)).toEqual(before); expect(read(w.a, "f1")).toBe(staged ? "f1 v0\n" : "peer\n");
});
for (const same of [true, false]) test(`T5 untracked ${same ? "identical adopted" : "different preserved"}`, () => {
	const w = world(); remote(w, "new.txt", "remote\n"); put(w.a, "new.txt", same ? "remote\n" : "draft\n"); const before = state(w.a); const r = apply(w);
	if (same) { expect(r.state).toBe("FAST_FORWARD"); expect(git(w.a, "status", "--porcelain", "--", "new.txt")).toBe(""); } else { expect(r.state).toBe("REFUSED"); expect(state(w.a)).toEqual(before); expect(read(w.a, "new.txt")).toBe("draft\n"); }
});
test("T6 content conflict refuses without mutation", () => { const w = diverged(), before = state(w.a); const r = apply(w); expect(r.reason).toBe("MERGE_CONFLICT"); expect(state(w.a)).toEqual(before); });
test("T7 upstream deletion removes clean disk and index path", () => { const w = world(); git(w.b, "rm", "gone"); git(w.b, "commit", "-q", "-m", "delete"); git(w.b, "push", "-q", "origin", "main"); expect(apply(w).state).toBe("FAST_FORWARD"); expect(read(w.a, "gone")).toBeNull(); expect(git(w.a, "ls-files", "--", "gone")).toBe(""); });
test("T8 behind-only fast-forwards exactly", () => { const w = world(); remote(w, "f2", "remote\n"); expect(apply(w).state).toBe("FAST_FORWARD"); expect(git(w.a, "rev-parse", "HEAD")).toBe(git(w.bare, "rev-parse", "main")); });
test("T9 push race reconverges, never force-overwrites origin", () => {
	const w = world(); local(w.a, "f1", "local\n"); const r = raced(w, "before_push", `remote('f2','raced\\n');`, true, { push: true });
	expect(r.pushed).toBe(true); expect(read(w.a, "f2")).toBe("raced\n"); expect(git(w.bare, "show", "main:f2")).toBe("raced"); expect(git(w.bare, "rev-parse", "main")).toBe(git(w.a, "rev-parse", "main")); expect(git(w.a, "merge-base", "--is-ancestor", git(w.b, "rev-parse", "HEAD"), "HEAD")).toBe("");
});
test("T10 lost CAS retry preserves a peer commit", () => { const w = world(); remote(w, "f2", "remote\n"); const r = raced(w, "before_ref", `local(a,'f3','peer\\n','peer mid-converge');`); expect(r.state).toBe("MERGED"); expect(git(w.a, "log", "--format=%s")).toContain("peer mid-converge"); expect(read(w.a, "f3")).toBe("peer\n"); expect(read(w.a, "f2")).toBe("remote\n"); });
test("T11 default reports without changing ref index or worktree", () => { const w = world(); remote(w, "f2", "remote\n"); const before = state(w.a), index = readFileSync(join(w.a, ".git/index")); const r = convergeRepository({ repo: w.a }); expect(r.state).toBe("FAST_FORWARD"); expect(r.applied).toBe(false); expect(state(w.a)).toEqual(before); expect(readFileSync(join(w.a, ".git/index"))).toEqual(index); expect(read(w.a, "f2")).toBe("f2 v0\n"); });
test("T12 detached main refuses", () => { const w = world(); git(w.a, "checkout", "-q", "--detach"); expect(apply(w).reason).toBe("NOT_ON_MAIN"); });
for (const oursLonger of [true, false]) {
	test(`T${oursLonger ? 13 : 14} strict prefix is advisory, not an automatic resolution`, () => { const w = hinted(oursLonger), before = state(w.a); const r = apply(w); expect(r.reason).toBe("MERGE_CONFLICT"); expect(r.conflicts).toEqual([{ path: "f1", kind: "CONTENT_CONFLICT", class: "true_divergence", hint: oursLonger ? "theirs_behind" : "ours_behind" }]); expect(state(w.a)).toEqual(before); });
	test(`T${oursLonger ? 13 : 14} owner explicitly selects ${oursLonger ? "ours" : "theirs"}`, () => { const w = hinted(oursLonger), selected = oursLonger ? "ours" : "theirs"; const r = apply(w, { resolutions: { f1: selected } }); expect(r.state).toBe("MERGED"); expect(r.resolutions).toEqual({ f1: selected }); expect(read(w.a, "f1")).toBe("v2\n"); expect(git(w.a, "show", "HEAD:f1")).toBe("v2"); expect(read(w.a, "f3")).toBe("local f3\n"); });
}
test("T15 genuine divergence has no hint", () => { const w = diverged(), before = state(w.a); const r = apply(w); expect(r.conflicts).toEqual([{ path: "f1", kind: "CONTENT_CONFLICT", class: "true_divergence" }]); expect(state(w.a)).toEqual(before); });
for (const selected of ["ours", "theirs"] as const) test(`T15 owner ${selected} resolves actual divergence`, () => { const w = diverged(); const r = apply(w, { resolutions: { f1: selected } }); expect(r.state).toBe("MERGED"); expect(read(w.a, "f1")).toBe(selected === "ours" ? "mine\n" : "theirs\n"); expect(git(w.a, "log", "-1", "--format=%B")).toContain(`f1=${selected}`); });
test("T16 unused owner resolution refuses without mutation", () => { const w = diverged(), before = state(w.a); expect(apply(w, { resolutions: { f1: "ours", f9: "ours" } }).reason).toBe("RESOLUTION_UNUSED"); expect(state(w.a)).toEqual(before); });
for (const overlap of [true, false]) test(`T17 peer stages ${overlap ? "same" : "unrelated"} path after planning`, () => {
	const w = world(); remote(w, "f1", "remote\n"); const head = git(w.a, "rev-parse", "HEAD"), path = overlap ? "f1" : "f3";
	const r = raced(w, "after_hash", `put(a,${JSON.stringify(path)},'peer staged\\n');g(a,'add',${JSON.stringify(path)});`);
	expect(read(w.a, path)).toBe("peer staged\n"); expect(git(w.a, "show", `:${path}`)).toBe("peer staged"); expect(existsSync(join(w.a, ".git/index.lock"))).toBe(false);
	if (overlap) { expect(r.reason).toBe("INDEX_RACE"); expect(r.applied).toBe(false); expect(git(w.a, "rev-parse", "HEAD")).toBe(head); } else { expect(r.state).toBe("FAST_FORWARD"); expect(read(w.a, "f1")).toBe("remote\n"); }
});
function restored(): World { const w = world(); for (const v of ["B\n", "C\n"]) local(w.a, "f1", v); for (const v of ["B\n", "D\n", "B\n"]) remote(w, "f1", v); return w; }
test("T18 intentional origin restore is not stale and has no hint", () => { const w = restored(), before = state(w.a); expect(apply(w).conflicts).toEqual([{ path: "f1", kind: "CONTENT_CONFLICT", class: "true_divergence" }]); expect(state(w.a)).toEqual(before); });
test("T18 owner theirs keeps intentional origin restore", () => { const w = restored(); expect(apply(w, { resolutions: { f1: "theirs" } }).state).toBe("MERGED"); expect(read(w.a, "f1")).toBe("B\n"); expect(git(w.a, "log", "-1", "--format=%B")).toContain("f1=theirs"); });
function prefix(): World { const w = world(); for (const v of ["B\n", "D\n", "C\n"]) local(w.a, "f1", v); for (const v of ["B\n", "D\n"]) remote(w, "f1", v); remote(w, "f2", "remote\n"); return w; }
test("T19 multiline strict-prefix history only hints", () => { const w = prefix(), before = state(w.a); expect(apply(w).conflicts[0]?.hint).toBe("theirs_behind"); expect(state(w.a)).toEqual(before); });
test("T19 owner ours keeps newer local and unrelated origin change", () => { const w = prefix(); expect(apply(w, { resolutions: { f1: "ours" } }).state).toBe("MERGED"); expect(read(w.a, "f1")).toBe("C\n"); expect(git(w.a, "show", "HEAD:f1")).toBe("C"); expect(read(w.a, "f2")).toBe("remote\n"); });
test("T20 merge path history refuses without prefix hint", () => {
	const w = world(); local(w.a, "f1", "B\n"); local(w.a, "f1", "C\n"); git(w.b, "checkout", "-q", "-b", "side"); local(w.b, "f1", "B\n", "side B"); git(w.b, "checkout", "-q", "main"); local(w.b, "f2", "remote\n", "main f2"); git(w.b, "merge", "-q", "--no-ff", "--no-edit", "side"); git(w.b, "push", "-q", "origin", "main"); const before = state(w.a); expect(apply(w).conflicts).toEqual([{ path: "f1", kind: "CONTENT_CONFLICT", class: "true_divergence" }]); expect(state(w.a)).toEqual(before);
});
test("T21 every lost CAS restores written entries and preserves unrelated staging", () => {
	const w = world(); remote(w, "f2", "remote\n"); const r = raced(w, "before_ref", `if(n===0){put(a,'f4','staged\\n');g(a,'add','f4');}local(a,'f3','peer '+n+'\\n','peer '+n);remote('f1','remote '+n+'\\n');`, false);
	expect(r.reason).toBe("RETRIES_EXHAUSTED"); expect(r.applied).toBe(false); expect(r.restore_skipped).toBeUndefined(); expect(git(w.a, "diff", "--cached", "--name-only", "HEAD")).toBe("f4"); expect(git(w.a, "log", "--format=%s")).not.toContain("git_converge"); expect(read(w.a, "f2")).toBe("f2 v0\n"); expect(read(w.a, "f3")).toBe("peer 2\n"); expect(existsSync(join(w.a, ".git/index.lock"))).toBe(false);
});
test("T21b rollback skips peer-restaged entry but restores other written entries", () => {
	const w = world(); put(w.b, "f1", "remote f1\n"); put(w.b, "f2", "remote f2\n"); git(w.b, "commit", "-q", "-am", "remote both"); git(w.b, "push", "-q", "origin", "main");
	const head = git(w.a, "rev-parse", "HEAD"), r = raced(w, "before_ref", `local(a,'f3','peer\\n');put(a,'f1','peer restaged\\n');g(a,'add','f1');`);
	expect(r.restore_skipped).toEqual(["f1"]); expect(r.applied).toBe(false); expect(git(w.a, "show", ":f1")).toBe("peer restaged"); expect(read(w.a, "f1")).toBe("peer restaged\n"); expect(git(w.a, "diff", "--cached", "--name-only", "HEAD")).toBe("f1"); expect(git(w.a, "diff", "--cached", "HEAD", "--", "f2")).toBe(""); expect(read(w.a, "f2")).toBe("f2 v0\n"); expect(git(w.a, "rev-parse", "HEAD^")).toBe(head);
});
test("rollback never unstages an entry a peer already committed", () => {
	const w = world(); remote(w, "f2", "remote\n"); const r = raced(w, "before_ref", `g(a,'commit','-q','-m','peer commits our staged entry');remote('f1','race '+n+'\\n');`, false);
	expect(r.restore_skipped).toContain("f2"); expect(r.applied).toBe(false); expect(git(w.a, "diff", "--cached", "HEAD", "--", "f2")).toBe(""); expect(git(w.a, "show", "HEAD:f2")).toBe("remote"); expect(read(w.a, "f2")).toBe("f2 v0\n");
});
test("push implies apply and rejected publication reports the real failure", () => {
	const w = world(); local(w.a, "f1", "local\n"); const hooks = join(w.dir, "hooks"); mkdirSync(hooks); writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\necho rejected >&2\nexit 1\n"); chmodSync(join(hooks, "pre-push"), 0o755); git(w.a, "config", "core.hooksPath", hooks);
	const r = convergeRepository({ repo: w.a, push: true }); expect(r.applied).toBe(true); expect(r.pushed).toBe(false); expect(r.reason).toBe("PUSH_FAILED"); expect(r.push_error).toContain("rejected");
});
test("unrelated deletion, executable mode and symlink survive convergence", () => {
	const w = world(); remote(w, "f1", "remote\n"); unlinkSync(join(w.a, "gone")); chmodSync(join(w.a, "f3"), 0o755); unlinkSync(join(w.a, "f4")); symlinkSync("f3", join(w.a, "f4")); const before = git(w.a, "ls-files", "-s", "--", "gone", "f3", "f4"); expect(apply(w).applied).toBe(true); expect(read(w.a, "gone")).toBeNull(); expect(readlinkSync(join(w.a, "f4"))).toBe("f3"); expect(git(w.a, "ls-files", "-s", "--", "gone", "f3", "f4")).toBe(before); expect(git(w.a, "diff", "--summary")).toContain("100644 => 100755");
});
test("remote executable and symlink additions update disk and index", () => {
	const w = world(); put(w.b, "exec", "#!/bin/sh\nexit 0\n"); chmodSync(join(w.b, "exec"), 0o755); symlinkSync("exec", join(w.b, "link")); git(w.b, "add", "exec", "link"); git(w.b, "commit", "-q", "-m", "modes"); git(w.b, "push", "-q", "origin", "main"); expect(apply(w).applied).toBe(true); expect(readlinkSync(join(w.a, "link"))).toBe("exec"); expect(git(w.a, "diff", "HEAD", "--", "exec", "link")).toBe(""); expect(git(w.a, "ls-files", "-s", "--", "exec")).toStartWith("100755");
});
test("post-CAS dirty race preserves new peer bytes and reports races", () => { const w = world(); remote(w, "f1", "remote\n"); const r = raced(w, "before_ref", `put(a,'f1','peer dirty\\n');`); expect(r.applied).toBe(true); expect(r.races).toEqual(["f1"]); expect(read(w.a, "f1")).toBe("peer dirty\n"); expect(git(w.a, "show", ":f1")).toBe("remote"); });
test("live converge lock refuses rather than overwriting it", () => { const w = world(); const lock = join(w.a, ".git/git_converge.lock"); put(w.a, ".git/git_converge.lock", String(process.pid)); expect(apply(w).reason).toBe("CONVERGE_BUSY"); expect(readFileSync(lock, "utf8")).toBe(String(process.pid)); });
const command = { name: "converge", description: "converge", usage: "converge --repo PATH", flags: [], example: "converge --repo .", runnable: true };
test("command reports usage, refused and successful exit classes", () => {
	expect(convergeCommand({ command, flags: new Map(), json: true, robot: false }).code).toBe(2);
	const w = world(); remote(w, "f1", "remote\n");
	const request = { command, flags: new Map<string, string | true>([["--repo", w.a]]), json: true, robot: false };
	expect(convergeCommand(request).code).toBe(0);
	put(w.a, "f1", "peer\n"); expect(convergeCommand(request).code).toBe(1);
});
test("command preserves ordered repeated owner declarations", () => {
	const w = world(); local(w.a, "f1", "mine f1\n"); local(w.a, "f2", "mine f2\n"); remote(w, "f1", "theirs f1\n"); remote(w, "f2", "theirs f2\n");
	const result = convergeCommand({ command, flags: new Map<string, string | true>([["--repo", w.a], ["--apply", true], ["--ours", "f2"]]), commandArgs: ["--ours", "f1", "--ours", "f2", "--theirs", "f1"], json: true, robot: false });
	expect(result.code).toBe(0); expect(read(w.a, "f1")).toBe("theirs f1\n"); expect(read(w.a, "f2")).toBe("mine f2\n");
});
function cleanTextMerge(): World {
	const w = world(), middle = Array.from({ length: 10 }, (_, i) => `unchanged ${i}\n`).join("");
	local(w.a, "f1", `first\n${middle}last\n`, "multiline baseline"); git(w.a, "push", "-q", "origin", "main"); git(w.b, "pull", "-q", "--ff-only", "origin", "main");
	local(w.a, "f1", `local first\n${middle}last\n`); remote(w, "f1", `first\n${middle}remote last\n`);
	return w;
}
test("whole-path owner gate refuses even when Git can cleanly merge disjoint hunks", () => {
	const w = cleanTextMerge(), before = state(w.a); git(w.a, "fetch", "-q", "origin");
	const merged = git(w.a, "merge-tree", "--write-tree", "HEAD", "origin/main");
	expect(git(w.a, "show", `${merged}:f1`)).toContain("local first"); expect(git(w.a, "show", `${merged}:f1`)).toContain("remote last");
	const r = apply(w); expect(r.reason).toBe("MERGE_CONFLICT"); expect(r.conflicts).toEqual([{ path: "f1", kind: "CONTENT_CONFLICT", class: "true_divergence" }]); expect(state(w.a)).toEqual(before);
});
for (const selected of ["ours", "theirs"] as const) test(`whole-path owner ${selected} resolves a clean textual merge`, () => {
	const w = cleanTextMerge(), expected = git(selected === "ours" ? w.a : w.b, "show", "HEAD:f1");
	const r = apply(w, { resolutions: { f1: selected } }); expect(r.applied).toBe(true); expect(git(w.a, "show", "HEAD:f1")).toBe(expected); expect(read(w.a, "f1")).toBe(`${expected}\n`);
});
test("command accepts attached declarations in original cross-flag order", () => {
	const w = diverged(), r = convergeCommand({ command, flags: new Map<string, string | true>([["--repo", w.a], ["--apply", true], ["--ours", "f1"], ["--theirs", "f1"]]), commandArgs: ["--theirs=f1", "--ours=f1"], json: true, robot: false });
	expect(r.code).toBe(0); expect(read(w.a, "f1")).toBe("mine\n");
});

function equalDualChange(): World { const w = world(); local(w.a, "f1", "same result\n", "local independent choice"); remote(w, "f1", "same result\n"); return w; }
test("equal-result independent dual changes still require their owner", () => {
	const w = equalDualChange(), before = state(w.a), r = apply(w);
	expect(r.reason).toBe("MERGE_CONFLICT"); expect(r.conflicts).toEqual([{ path: "f1", kind: "CONTENT_CONFLICT", class: "true_divergence" }]); expect(state(w.a)).toEqual(before);
});
for (const selected of ["ours", "theirs"] as const) test(`owner ${selected} admits equal-result independent dual changes`, () => {
	const w = equalDualChange(), r = apply(w, { resolutions: { f1: selected } });
	expect(r.applied).toBe(true); expect(r.state).toBe("MERGED"); expect(r.resolutions).toEqual({ f1: selected }); expect(git(w.a, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3); expect(read(w.a, "f1")).toBe("same result\n");
});
function nestedChange(): World {
	const w = world(); mkdirSync(join(w.a, "dir")); put(w.a, "dir/file", "old nested\n"); git(w.a, "add", "dir/file"); git(w.a, "commit", "-q", "-m", "nested baseline"); git(w.a, "push", "-q", "origin", "main"); git(w.b, "pull", "-q", "--ff-only", "origin", "main"); remote(w, "dir/file", "new nested\n");
	mkdirSync(join(w.dir, "outside")); put(w.dir, "outside/file", "old nested\n"); return w;
}
test("symlinked parent refuses before index or main changes, preserving the external target", () => {
	const w = nestedChange(); renameSync(join(w.a, "dir"), join(w.a, "saved-dir")); symlinkSync(join(w.dir, "outside"), join(w.a, "dir"));
	const head = git(w.a, "rev-parse", "HEAD"), index = readFileSync(join(w.a, ".git/index")), r = apply(w);
	expect(r.reason).toBe("UNSAFE_PARENT"); expect(r.applied).toBe(false); expect(read(w.dir, "outside/file")).toBe("old nested\n"); expect(git(w.a, "rev-parse", "HEAD")).toBe(head); expect(readFileSync(join(w.a, ".git/index"))).toEqual(index);
});
for (const when of ["before_ref", "before_write"] as const) test(`parent symlink replacement ${when} never writes through to an external target`, () => {
	const w = nestedChange(), action = `renameSync(join(a,'dir'),join(a,'saved-dir'));symlinkSync(${JSON.stringify(join(w.dir, "outside"))},join(a,'dir'));`;
	const r = raced(w, when, action);
	expect(r.applied).toBe(true); expect(r.races).toEqual(["dir/file"]); expect(read(w.dir, "outside/file")).toBe("old nested\n"); expect(read(w.a, "saved-dir/file")).toBe("old nested\n"); expect(readlinkSync(join(w.a, "dir"))).toBe(join(w.dir, "outside"));
});
test("ordinary nested directories still receive their remote contents", () => { const w = nestedChange(), r = apply(w); expect(r.applied).toBe(true); expect(read(w.a, "dir/file")).toBe("new nested\n"); expect(git(w.a, "diff", "HEAD", "--", "dir/file")).toBe(""); });

function exitedPid(): number {
	const child = spawnSync(process.execPath, ["-e", ""], { env: cleanEnv });
	if (child.status !== 0 || !child.pid) throw new Error("Unable to create an exited lock owner");
	return child.pid;
}
test("dead conventional lock is reclaimed and convergence remains functional", () => {
	const w = world(); remote(w, "f1", "remote\n"); put(w.a, ".git/git_converge.lock", String(exitedPid()));
	const r = apply(w); expect(r.applied).toBe(true); expect(read(w.a, "f1")).toBe("remote\n"); expect(existsSync(join(w.a, ".git/git_converge.lock"))).toBe(false);
});
test("dead CAS authority is replaced using its exact token, not its pathname", () => {
	const w = world(), pid = exitedPid();
	const token = spawnSync(realGit, ["-C", w.a, "hash-object", "-w", "--stdin"], { env: cleanEnv, input: `${pid}\nabandoned-unique-token\n`, encoding: "utf8" });
	if (token.status !== 0) throw new Error(token.stderr);
	git(w.a, "update-ref", "refs/omp-kit/converge-lock", token.stdout.trim()); put(w.a, ".git/git_converge.lock", String(pid)); remote(w, "f1", "remote\n");
	expect(apply(w).applied).toBe(true); expect(read(w.a, "f1")).toBe("remote\n"); expect(git(w.a, "for-each-ref", "--format=%(refname)", "refs/omp-kit/converge-lock")).toBe("");
});
test("two simultaneous stale-lock reclaimers cannot delete the active replacement lock", async () => {
	const w = world(); remote(w, "f1", "remote\n"); put(w.a, ".git/git_converge.lock", String(exitedPid()));
	const bin = join(w.dir, "concurrent-bin"); mkdirSync(bin);
	const wrapper = join(bin, "git");
	writeFileSync(wrapper, `#!${process.execPath}
import {spawnSync} from 'node:child_process'; import {existsSync,readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
const args=process.argv.slice(2), label=process.env.CONVERGE_CASE, other=label==='a'?'b':'a', dir=${JSON.stringify(w.dir)}, real=${JSON.stringify(realGit)};
function waitFor(path){const deadline=Date.now()+10000;while(!existsSync(path)){if(Date.now()>deadline)throw new Error('concurrency rendezvous timed out: '+path);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}
if(args[2]==='update-ref'&&args[3]==='refs/omp-kit/converge-lock'){writeFileSync(join(dir,'ready-'+label),'ready');waitFor(join(dir,'ready-'+other));}
if(args[2]==='symbolic-ref'){waitFor(join(dir,'finished-'+other));if(readFileSync(join(${JSON.stringify(w.a)},'.git/git_converge.lock'),'utf8')!==String(process.ppid))throw new Error('active replacement PID file was removed');}
const p=spawnSync(real,args,{env:process.env,input:readFileSync(0)});process.stdout.write(p.stdout??'');process.stderr.write(p.stderr??'');process.exit(p.status??1);
`);
	chmodSync(wrapper, 0o755);
	const source = `import {convergeRepository} from ${JSON.stringify(join(root, "src/converge.ts"))};import {writeFileSync} from 'node:fs';const r=convergeRepository({repo:${JSON.stringify(w.a)},apply:true});writeFileSync(${JSON.stringify(join(w.dir, "finished-"))}+process.env.CONVERGE_CASE,'finished');console.log(JSON.stringify(r));`;
	const children = ["a", "b"].map(label => Bun.spawn([process.execPath, "-e", source], { env: { ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH}`, CONVERGE_CASE: label }, stdout: "pipe", stderr: "pipe" }));
	const outputs = await Promise.all(children.map(async child => { const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); if (status !== 0) throw new Error(stderr); return JSON.parse(stdout) as ConvergeResult; }));
	expect(outputs.filter(r => r.applied)).toHaveLength(1); expect(outputs.filter(r => r.reason === "CONVERGE_BUSY")).toHaveLength(1); expect(read(w.a, "f1")).toBe("remote\n"); expect(existsSync(join(w.a, ".git/git_converge.lock"))).toBe(false); expect(git(w.a, "for-each-ref", "--format=%(refname)", "refs/omp-kit/converge-lock")).toBe("");
}, 20_000);
test("unverifiable stale-file ownership refuses instead of deleting an unknown lock", () => {
	const w = world(); put(w.a, ".git/git_converge.lock", "not-a-verifiable-owner");
	expect(apply(w).reason).toBe("CONVERGE_LOCK_UNVERIFIED"); expect(readFileSync(join(w.a, ".git/git_converge.lock"), "utf8")).toBe("not-a-verifiable-owner"); expect(git(w.a, "for-each-ref", "--format=%(refname)", "refs/omp-kit/converge-lock")).toBe("");
});
test("a dead CAS owner permits recovery of its interrupted empty PID-file write", () => {
	const w = world(), pid = exitedPid(), token = spawnSync(realGit, ["-C", w.a, "hash-object", "-w", "--stdin"], { env: cleanEnv, input: `${pid}\ncrashed-before-pid-write\n`, encoding: "utf8" });
	if (token.status !== 0) throw new Error(token.stderr);
	git(w.a, "update-ref", "refs/omp-kit/converge-lock", token.stdout.trim()); put(w.a, ".git/git_converge.lock", "");
	expect(apply(w).applied).toBe(true); expect(existsSync(join(w.a, ".git/git_converge.lock"))).toBe(false); expect(git(w.a, "for-each-ref", "--format=%(refname)", "refs/omp-kit/converge-lock")).toBe("");
});
test("report mode acquires no CAS authority or PID file and changes no refs or index", () => {
	const w = world(); remote(w, "f1", "remote\n"); git(w.a, "fetch", "-q", "origin");
	const refs = git(w.a, "for-each-ref", "--format=%(refname) %(objectname)"), index = readFileSync(join(w.a, ".git/index"));
	const r = convergeRepository({ repo: w.a, fetch: false });
	expect(r.state).toBe("FAST_FORWARD"); expect(r.applied).toBe(false); expect(git(w.a, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refs); expect(readFileSync(join(w.a, ".git/index"))).toEqual(index); expect(existsSync(join(w.a, ".git/git_converge.lock"))).toBe(false); expect(read(w.a, "f1")).toBe("f1 v0\n");
});
