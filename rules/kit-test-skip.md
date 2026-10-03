---
description: "NE-6 AST candidate for bead ompkit-rc-epic-land-fix-release-dogfood-rz5.18; external precondition is OMP pre-execution AST interruption support from #13303; close criterion is the live test-skip-ts-fire scenario and the full 274-case corpus running green"
condition:
  - '#\[ignore\b'
  - '\b(it|test|describe)\.skip\('
  - '\bx(it|describe)\('
  - '@pytest\.mark\.(skip(?:if)?|xfail)\b'
  - '@unittest\.skip'
  - '\bt\.Skip(Now|f)?\('
  - '\\tt\.Skip(Now|f)?\('
astLiveScenario: test-skip-ts-fire
astCondition:
  - "#[ignore]"
  - "$F.skip($$$ARGS)"
  - "x$F($$$ARGS)"
  - "@pytest.mark.skip($$$ARGS)"
  - "@pytest.mark.skipif($$$ARGS)"
  - "@pytest.mark.xfail($$$ARGS)"
  - "@unittest.skip($$$ARGS)"
  - "$F.Skip($$$ARGS)"
  - "$F.SkipNow($$$ARGS)"
  - "$F.Skipf($$$ARGS)"
scope: "tool:edit(**/*.rs), tool:edit(**/*.ts), tool:edit(**/*.tsx), tool:edit(**/*.js), tool:edit(**/*.jsx), tool:edit(**/*.mjs), tool:edit(**/*.cjs), tool:edit(**/*.py), tool:edit(**/*.go), tool:edit(**/tests/**), tool:edit(**/spec/**), tool:write(**/*.rs), tool:write(**/*.ts), tool:write(**/*.tsx), tool:write(**/*.js), tool:write(**/*.jsx), tool:write(**/*.mjs), tool:write(**/*.cjs), tool:write(**/*.py), tool:write(**/*.go), tool:write(**/tests/**), tool:write(**/spec/**)"
interruptMode: always
---
**Blocked before it was written.** Your last edit adds a skip or ignore marker to a test. The file was not changed. Do not re-issue the same edit.

You are adding a skip/ignore marker to a test. Under AGENTS.md this is gate self-weakening (pattern 1) unless the skip is the honest state of the world.

Allowed only if ALL of these are true, stated in the same edit: (1) the skip names a bead id that tracks re-enabling it, (2) the reason is an external precondition (missing credential, unavailable hardware), not "it fails", (3) the bead's close criterion is the test running green. Otherwise revert the skip and fix the code, or record the failure in docs/evidence/NEGATIVE_EVIDENCE.md and leave the test red.
