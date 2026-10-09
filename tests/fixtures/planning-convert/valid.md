### 0.9 Work items — valid conversion fixture

```text
### root-task — Measure the isolated conversion path
 type: task   priority: 1
labels: plan:core8, mission:core8, project:omp-kit-companion, G1
depends-on: (none)
relates: CONV1
existing: (new)
discovered-from: fixture-plan
WHAT: (a) The converter records the root item's independent behavior.
WHY: The root item provides a stable dependency target for its child.
ACCEPTANCE:
- [a] The native database contains this item with the declared fields.
- [a] Planted negative: repeating conversion to the same database is refused before another item is created.
NO-CLAIM: A clean dry run does not prove the plan is correct.
```

```text
### child-bug — Preserve cross-tracker references without edges
 type: bug   priority: 1
labels: plan:core8, mission:core8, project:omp-kit-companion, G2
depends-on: root-task, external:482
relates: old:reference
remove-depends-on: legacy:edge
existing: example.tracker.42 (amend)
discovered-from: fixture issue
WHAT: (a) The native blocking dependency resolves to root-task only.
WHY: External identifiers provide context and must not become plan edges.
## Steps to Reproduce
Run the isolated conversion and inspect the child's dependency list.
ACCEPTANCE:
- [a] One native plan dependency points to root-task; external:482 remains in the description.
- [a] Planted negative: external:482 must not become a blocking dependency.
NO-CLAIM: This fixture does not prove existing-tracker migration.
```

```text
### plan-epic — Preserve the epic success criteria section
 type: epic   priority: 2
labels: plan:core8, mission:core8, project:omp-kit-companion, G3
depends-on: child-bug
existing: (new)
discovered-from: fixture-plan
WHAT: (a) The plan epic retains its success criteria under the synthetic core8 parent.
WHY: The epic template is part of the source contract.
## Success Criteria
The isolated issue description retains this section verbatim.
ACCEPTANCE:
- [a] The native issue description contains this success-criteria section.
- [a] Planted negative: omitting the section is reported by lint.
NO-CLAIM: This does not certify that the plan is complete.
```
