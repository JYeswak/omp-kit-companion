import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixture } from "./fixture-process.ts";

let bundledCli: string | undefined;

/** Declarative output only: runtime commands still need the source launcher's root identity. */
export function cliOutputBundle(): string {
	if (bundledCli) return bundledCli;
	const repo = resolve(import.meta.dir, "../..");
	const scratch = ownedTmp("cli-output-bundle");
	const build = runFixture([process.execPath, "build", join(repo, "src/cli.ts"),
		"--target=bun", "--format=esm", `--outdir=${scratch.path}`], { cwd: repo, floor_s: 30 });
	if (build.rc !== 0) throw new Error(`fixture CLI bundle failed (${build.rc}): ${new TextDecoder().decode(build.stderr)}`);
	const path = join(scratch.path, "cli.js");
	bundledCli = path;
	return path;
}
