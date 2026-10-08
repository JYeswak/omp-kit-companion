---
name: scratch-is-not-a-home
description: "Fires before a durable artifact is written into var/agent-tmp scratch: prompts, packets, rules, skills, launchers, or a copy of a repo's source. Scratch is for one run's throwaway output; anything reused goes to version control."
condition:
  # Path-scoped tripwire: any content written to a durable-shaped path under scratch fires.
  # MEASURED 2026-10-08 over 37,276 write/edit calls (94 session files, all profiles, last 3 days):
  # 6,984 (18.7%) went into var/agent-tmp. Of those, by class: instructional 173 (0.46% of all
  # writes), launcher/driver scripts 510 (1.37%), shadow source trees under scratch 557 (1.49%).
  # Loose one-off code (1,731, 4.64%) is deliberately NOT in this rule: probes are legitimate scratch.
  - "[\\s\\S]"
scope:
  - "tool:write(**/var/agent-tmp/**/*{PROMPT,Prompt,prompt}*)"
  - "tool:edit(**/var/agent-tmp/**/*{PROMPT,Prompt,prompt}*)"
  - "tool:write(**/var/agent-tmp/**/{PACKET,Packet,packet}*)"
  - "tool:edit(**/var/agent-tmp/**/{PACKET,Packet,packet}*)"
  - "tool:write(**/var/agent-tmp/**/rules/*.md)"
  - "tool:edit(**/var/agent-tmp/**/rules/*.md)"
  - "tool:write(**/var/agent-tmp/**/skills/**)"
  - "tool:edit(**/var/agent-tmp/**/skills/**)"
  - "tool:write(**/var/agent-tmp/**/*.sh)"
  - "tool:edit(**/var/agent-tmp/**/*.sh)"
  - "tool:write(**/var/agent-tmp/**/{src,tests,scripts}/**)"
  - "tool:edit(**/var/agent-tmp/**/{src,tests,scripts}/**)"
interruptMode: tool-only
---

# Scratch is not a home. Decide where this belongs before you write it.

The path is under `var/agent-tmp/`, the scratch area the reaper deletes. What you are writing
looks like something that will be run again, or will instruct an agent: a prompt, a packet, a
rule, a skill, a launcher, or a copy of a repo's source. Measured 2026-10-08: 18.7% of all fleet
writes went to scratch. The live product injector stopped that night (`lane-driver.py`) lived
there, and whole copies of omp-kit's `src/` were edited there instead of in the canonical checkout.

| What it is | Where it goes |
|---|---|
| Raw command output, logs, captures, intermediate data, a probe you will not run again | Scratch: `var/agent-tmp/<label>.<pid>/` with `.owner` |
| Anything a person or agent will run again: script, launcher, driver | The owning repo, under git, registered (e.g. `scripts/README.md`) |
| Anything that instructs an agent: prompt, packet skeleton, grader prompt, rule, skill | Fleet-wide: `omp-kit-companion` (`rules/`, `skills/`, `cases/cases.tsv`). Project adapter: the project repo. Prompt revisions: the prompt library (`prompt: <id>@<sha>`) |
| A change to another repo's source | That repo's canonical checkout, under a reservation. A copy in scratch is a worktree by another name (AGENTS RULE 3) |
| A result others will rely on: a grade, a decision, a receipt | Its durable home: an Agent Mail board message, a bead comment, or a repo doc. Scratch is staging only |

If commits are paused, do not build it here and leave it here. Write down the target path and
its owner, and send it to that owner in the same turn.
