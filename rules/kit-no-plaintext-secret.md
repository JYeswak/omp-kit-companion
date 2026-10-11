---
description: "ompkit-l8h5: never write a literal secret into a file, rc, config or command; source it from Infisical at point of use"
condition:
  # Secret-shaped NAME (an _-component that is a credential noun; a trailing _ID/_PATH/_FILE/_URL/_NAME/_DIR
  # component makes it a pointer, not a secret), optional (JSON-escaped) quote, = or :, optional quote, then
  # a literal: starts alphanumeric, 20+ token chars, holds a digit and a letter. $..., <...>, !cmd,
  # xxx/changeme placeholders and bare names cannot start or fill that class, so they stay quiet.
  # Lookaheads are bounded ({0,200}); every repeat is over an exclusive class.
  - '\b(?:[A-Z0-9]{1,40}_){0,8}(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PAT|CREDENTIALS?)(?:_(?!(?:ID|PATH|FILE|URL|NAME|DIR)(?![A-Z0-9]))[A-Z0-9]{1,40}){0,8}(?![A-Za-z0-9_])(?:\\?["''])?[ \t]{0,4}[:=][ \t]{0,4}(?:\\?["''])?(?=[A-Za-z0-9_./+-]{0,200}[0-9])(?=[A-Za-z0-9_./+-]{0,200}[A-Za-z])[A-Za-z0-9][A-Za-z0-9_./+-]{19}'
  - '\bBearer[ \t]{1,4}(?=[A-Za-z0-9_./+-]{0,200}[0-9])(?=[A-Za-z0-9_./+-]{0,200}[A-Za-z])[A-Za-z0-9][A-Za-z0-9_./+-]{19}'
scope: "tool:bash, tool:write(**/*.env), tool:edit(**/*.env), tool:write(**/.env), tool:edit(**/.env), tool:write(**/.env.*), tool:edit(**/.env.*), tool:write(**/.zshrc), tool:edit(**/.zshrc), tool:write(**/.zshenv), tool:edit(**/.zshenv), tool:write(**/.zprofile), tool:edit(**/.zprofile), tool:write(**/.bashrc), tool:edit(**/.bashrc), tool:write(**/.bash_profile), tool:edit(**/.bash_profile), tool:write(**/.profile), tool:edit(**/.profile), tool:write(**/*.json), tool:edit(**/*.json), tool:write(**/*.toml), tool:edit(**/*.toml), tool:write(**/*.yaml), tool:edit(**/*.yaml), tool:write(**/*.yml), tool:edit(**/*.yml), tool:write(**/*.sh), tool:edit(**/*.sh), tool:write(**/*.zsh), tool:edit(**/*.zsh), tool:write(**/*.plist), tool:edit(**/*.plist), tool:write(**/*.conf), tool:edit(**/*.conf), tool:write(**/*.ini), tool:edit(**/*.ini)"
interruptMode: always
---
**Blocked before it was written.** The call you were writing puts a literal secret value into a file, rc file, config or command line. It was cut off while you wrote it and did not run. Do not re-issue it unchanged.

Secrets live only in Infisical (Josh, 2026-10-11: "source properly from infisical or bust"). Fetch them at point of use, in memory:

- Shell or rc: `export FOO_API_KEY="$(cf-secret FOO_API_KEY)"`, or `. ~/.local/share/infisical-helpers/lib.sh && inf_export_live <projectId> FOO_API_KEY`.
- MCP/agent config: reference the variable (`"Authorization": "Bearer ${FOO_TOKEN}"`, `"env": {"FOO_TOKEN": "${FOO_TOKEN}"}`) or a command value (`!cf-secret FOO_TOKEN`), and have the launcher export it from Infisical.
- A value that is not in Infisical yet: add it there first (`infisical-set`), then reference it.
- Tests and examples: use an obvious placeholder (`<your-key>`, `xxx`) or mint a synthetic value at runtime; never a real key.

If a real value was already written somewhere, run `omp-kit doctor --scope secrets` to find every file holding a vault value, remove it, and rotate the secret.
