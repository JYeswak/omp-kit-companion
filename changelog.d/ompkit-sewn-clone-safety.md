# Browser reaper safety

Browser cleanup still terminates an orphan Chrome by recorded PID, but excludes any code-sign clone referenced by a live Chrome from quarantine.
