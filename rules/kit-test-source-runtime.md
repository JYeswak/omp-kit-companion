---
description: "C10: source tests and fixtures must bind the candidate, not the host-installed omp-kit"
condition:
  - '\b(?:run|run_bounded|spawn|spawnSync|execFile|execFileSync)\s*\(\s*(?:\[\s*)?["''](?:omp-kit|[^"''\n]*[.]local/opt/[^"''\n]+)["'']'
  - '\b(?:exec|execSync)\s*\(\s*["''](?:omp-kit(?=[ \t])|[^"''\n]*[.]local/opt/)'
  # Split shell alternatives so each condition has a consuming required literal
  # for regex-budget's adversarial probe; preserve the original match union.
  - '(?m)^[ \t+]*(?:[A-Za-z_][A-Za-z0-9_]*=\$\([ \t]*)?omp-kit(?=[ \t)])'
  - '(?m)^[ \t+]*(?:[A-Za-z_][A-Za-z0-9_]*=\$\([ \t]*)?["''][^"''\n]*[.]local/opt/[^"''\n]*["''](?=[ \t)])'
  - '(?m)^[ \t+]*(?:[A-Za-z_][A-Za-z0-9_]*=\$\([ \t]*)?[^\s"''\n]*[.]local/opt/[^\s"''\n]*(?=[ \t)])'
scope: "tool:write(**/tests/**), tool:edit(**/tests/**), tool:write(**/fixtures/**), tool:edit(**/fixtures/**)"
interruptMode: always
---
**kit-test-source-runtime — bind test execution to the candidate under test.** A source test or fixture is about to launch bare `omp-kit` from PATH or a host `.local/opt` release. Tonight an installed predecessor rejected a source-only flag; a hermetic gate also refused native scratch creation that source tests had delegated to the installed CLI.

For current-feature tests, use the candidate executable/source entrypoint already provided by the fixture. Reuse shipped `kitlib_tmp.owned_tmp`/`ownedTmp` for fixture storage rather than requiring installed CLI scratch. For a deliberate predecessor-compatibility test, bind an explicit predecessor executable variable, assert its identity and declared API, then invoke that variable; do not silently inherit the operator's installation. Printing an install path, asserting help text, or production launch code is not this violation.

This syntax tripwire is not full shell/data-flow analysis. A variable executable is not itself proof that the right identity was selected; the test and its authoritative gate must establish that boundary.
