---
condition: '\|\s*(head|tail)\b[^;&|]*[;&]\s*[^;]*\$\?'
scope: tool:bash
interruptMode: never
---
`$?` after a pipeline reports the **last** command's status — `head`/`tail`, not the command you care about. Confirmed live: `bash -c 'exit 3' | head -1; echo $?` prints `0`. Measured here: 807 of 78,242 commands (1.03%), and it blinded this repo's own honesty gate 223 times. Take the exit code from a separate unpiped run, or `set -o pipefail`.
