---
description: "Run the production-safety-review repository workflow through OMA"
---
<!-- Generated OMA T1 saved-prompt projection; do not add orchestration logic here. -->

Delegate to the authoritative repository-workflow/v1 runner:

`oma workflow run production-safety-review --input "$ARGUMENTS"`

Return the CLI terminal and evidence. Do not spawn agents or decide ship/no-ship in this prompt.
