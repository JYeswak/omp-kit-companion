---
description: "DAILYCLASSES row 40: todo append requires a named phase"
condition:
  - '^\{(?=[^\r\n]*"op"\s*:\s*"append"\s*[,}])(?=[^\r\n]*"phase"\s*:\s*null\s*[,}])'
scope: tool:todo
interruptMode: never
---
kit-todo-append-phase: do not submit an append operation with phase null. Read the current list, choose its intended phase name, and supply that name with the items. The retained null-phase append failed with “Missing phase name for append operation”; no items were appended. This advisory covers the explicit null-phase call shape, not arbitrary JSON validation or a replacement for the upstream append fix.
