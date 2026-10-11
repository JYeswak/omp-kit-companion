---
description: "Use the ast-parsing-engineering workflow before hand-writing a quote-aware lexer"
condition:
  - '\b(?:in_?(?:single|double|quote|quoted|string|str)|in(?:Single|Double|Quote|Quoted|String|Str)|instr|quoted|quote(?:_?char|Char)?)\s*=\s*(?:false|False|None|null|undefined)\b|\b(?:in_?(?:quote|string|str)|in(?:Quote|String|Str)|instr|quoted|inside)\s*=\s*!\s*\w|\bquote(?:_?char|Char)?\s*=\s*(?:Some\()?(?:ch|c|char|character|chr|cur)\b|\b(?:quote(?:_?char|Char)?|inStr|in_str)\s*[!=]==?\s*(?:\\"''\\"|''\\"''|\\"\\\\\\"\\"|''\\\\''''|`\\"`)|\b(?:ch|c|char|character|chr|cur)\s*[!=]==?\s*quote(?:_?char|Char)?\b'
  - '\b(?:ch|c|char|character|chr|cur)\s*[!=]==?\s*(?:\\"''\\"|''\\"''|\\"\\\\\\"\\"|''\\\\''''|`\\"`)(?!\)?\s*(?:\w+\s*\+=|\w+\.push|=>\s*\w+\.push))'
  - '\b(?:ch|c|char|character|chr|cur)\s+in\s+(?:\\"''\\\\\\"\\"|''\\"\\\\''''|\\"\\\\\\"''\\"|''\\\\''\\"'')'
  - '\bchar(?:acter)?\s*(?:===|==|!==|!=)\s*(?:''(?:\\.|[^''\\])*''|"(?:\\.|[^"\\])*")'
  - '\bquote(?:d)?\s*(?:===|==|!==|!=)\s*(?:''(?:\\.|[^''\\])*''|"(?:\\.|[^"\\])*")'
  - '\b(?:inStr|in_str|inString|in_string|inside|quoted)\s*=\s*(?:ch|c|char|character|chr|cur)\b'
  - '\b(?:ch|c|char|character|chr|cur)\s+in\s+(?:''(?:\\.|[^''\\])*''|"(?:\\.|[^"\\])*")'
scope:
  - 'tool:write(**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,py,rs})'
  - 'tool:edit(**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,py,rs})'
interruptMode: never
---
**Before hand-writing a quote-aware scanner or tokenizer (shell commands, tool-call inputs, source code, SQL, JSON, YAML), read the `ast-parsing-engineering` skill first.** Prefer the native parser or tokenizer for that language (`shlex`/`shell-quote`, `JSON.parse`, `ast`, `syn`, TypeScript `createSourceFile`, tree-sitter/ast-grep). If you keep a hand lexer, pin the grammar subset it accepts, make unsupported syntax fail visibly at the decision boundary, and test quoted, escaped, nested, heredoc and prefix-plus-junk inputs against the real caller (for OMP guards: the real tool-input shape, e.g. hashline `edit` carries its target inside `input`). This is a reminder, not enforcement: firing does not prove the skill was applied.
