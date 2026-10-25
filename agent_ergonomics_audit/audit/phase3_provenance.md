# Phase 3 replay input provenance

Consumer: ERGO1 corpus reviewers reproducing the exact safe replay. Retire when the input corpus/scripts are deliberately superseded. Hashes below were read once after sanitization and after replay started; no inputs were changed during the run.

SHA-256:

- partial/intent_naive.jsonl: `d50dbde1745e31cd0402831ca3691d9ea2cdf1eadf15f62a09b26664735ba559`
- partial/intent_savvy.jsonl: `a66803c8076f1d92de60e8f333d4b43336f1e5401062fac40341566b4c1d27da`
- installed scripts/generate_intent_corpus.sh: `69806a582b57e1e117abb609646d062f22ec2096b4ce259f5595f53039322c39`
- installed scripts/run_intent_corpus.sh: `49f424951a8243c7e51865e2561062ecebf91d6bcfef1dfc44e9591ff4d6d1df`

The installed scripts live under `/Users/josh/.agents/skills/agent-ergonomics-and-intuitiveness-maximization-for-cli-tools/`. The target is the source wrapper, not the installed release. Wrapper source executes `bun "$here/src/cli.ts" "$@"`; audit results describe the shared source at run time, not a compiled/released immutable artifact. Concurrent source changes would weaken exact-revision attribution; no commit SHA is invented.

The naive corpus has two exact canonical-flag collisions (`--root` and `--version`) among its perturbations. Root --root has a required value and root --version is the documented identity query (src/cli.ts:221–224). Therefore a successful --version is not evidence of typo recovery. The seven perturbed env surfaces yield 16 rows whose argv are all --version; the version query need not consult the intended env setting. Existence of output does not establish whether an env typo was detected.

All 2,163 input rows are retained: 2,151 deterministic naive plus 12 preserved savvy. Nine rows are excluded (two naive, seven savvy); 2,154 are admitted. A final completed-run count belongs in phase3_results.md, not in an assumption about how many admitted probes actually finished.
