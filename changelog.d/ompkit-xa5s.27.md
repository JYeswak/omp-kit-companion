### Fixed

- The fleet guard no longer refuses every redirected `git commit --only`: a redirection (`>`, `>>`, `2>`, `&>`, `<`, `2>&1`) and its target are dropped before path analysis, and the `&` of a redirection no longer splits a command segment. Quoted `>` text, an unreserved path after a redirection, and a real `&&`/`&` second command are still refused. (ompkit-xa5s.27)
