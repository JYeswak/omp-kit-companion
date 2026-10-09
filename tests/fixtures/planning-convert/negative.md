### 0.9 Work items — planted-negative conversion fixture

```text
### bad-bug — Bug without reproduction steps
 type: bug   priority: 0
labels: plan:core8, mission:core8, project:omp-kit-companion, G1
depends-on: (none)
existing: (new)
discovered-from: fixture-negative
WHAT: (a) The bug item is still parsed and linted.
WHY: Missing reproduction steps must be visible in the report.
ACCEPTANCE:
- [a] The report identifies bad-bug as missing its required section.
- [a] Planted negative: a bug without reproduction steps cannot produce a clean report.
NO-CLAIM: This fixture does not prove the reported bug is real.
```

```text
### bad-label — Label contains a dot
 type: task   priority: 1
labels: plan:core8, mission:core8, invalid.label
depends-on: (none)
existing: (new)
discovered-from: fixture-negative
WHAT: (a) The invalid source label is reported with its item slug.
WHY: Native bead labels reject dots.
ACCEPTANCE:
- [a] The report identifies bad-label and invalid.label.
- [a] Planted negative: invalid.label is never converted into a native label.
NO-CLAIM: This does not test cross-tracker label mapping.
```

```text
### uncovered-letter — WHAT letter has no acceptance citation
 type: task   priority: 1
labels: plan:core8, mission:core8, project:omp-kit-companion, G2
depends-on: (none)
existing: (new)
discovered-from: fixture-negative
WHAT: (a) This WHAT letter has no acceptance box.
WHY: Coverage must be checked per WHAT letter.
ACCEPTANCE:
- [b] This box cites an undeclared letter.
- [b] Planted negative: this negative also cites an undeclared letter.
NO-CLAIM: The diagnostic does not establish plan correctness.
```

```text
### cycle-left — First member of a planted dependency cycle
 type: task   priority: 1
labels: plan:core8, mission:core8, project:omp-kit-companion, G3
depends-on: cycle-right
existing: (new)
discovered-from: fixture-negative
WHAT: (a) The first cycle member is named in the cycle report.
WHY: Cycles must block a clean conversion.
ACCEPTANCE:
- [a] The report lists cycle-left and cycle-right in one cycle.
- [a] Planted negative: a dependency cycle never exits cleanly.
NO-CLAIM: This fixture does not prove dependency semantics elsewhere.
```

```text
### cycle-right — Second member of a planted dependency cycle
 type: task   priority: 1
labels: plan:core8, mission:core8, project:omp-kit-companion, G3
depends-on: cycle-left
existing: (new)
discovered-from: fixture-negative
WHAT: (a) The second cycle member is named in the cycle report.
WHY: Cycles must block a clean conversion.
ACCEPTANCE:
- [a] The report lists cycle-right and cycle-left in one cycle.
- [a] Planted negative: a dependency cycle never exits cleanly.
NO-CLAIM: This fixture does not prove dependency semantics elsewhere.
```

```text
### malformed-item
This candidate block does not have the required slug/title separator.
```
