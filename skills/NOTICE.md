# QA Skills — canonical Skill Bundle

Copyright 2026 Dang Nguyen

Licensed under the Apache License, Version 2.0. You may not use these files except in compliance
with the License. A copy is at <http://www.apache.org/licenses/LICENSE-2.0>, and the full text
ships with the `@gwinnguyen/qa-skills` package and lives at
<https://github.com/dangnhit/qa-tester/blob/main/LICENSE>.

## If you are reading this inside your own repository

`qa-skill skills install` copied this directory here, and this file travels with it so the copy
does not arrive stripped of the license it is under.

These files are **managed**. The installation manifest beside them (`.qa-skill-manifest.json`)
records a sha256 for every one, so editing any of them in place is reported as drift by:

```bash
qa-skill skills verify --agent <codex|claude|cursor>
```

To change a skill, change it upstream and run `qa-skill skills update` — an edit made here is
overwritten by the next update, or preserved only at the cost of failing verification. To remove
them, run `qa-skill skills uninstall`, which deletes the files it owns and reports anything it
does not.
