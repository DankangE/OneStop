---
name: jira-spec-extraction
description: Extracts Jira behavior into the tracker's clean-room spec using context7 docs and REA response-shape captures. Use when adding a Jira feature to tracker/, when the user asks how Jira does something, or when updating tracker/spec/jira-rest-v3.md.
---

# Jira spec extraction

Follow `.cursor/rules/cleanroom-reverse-engineering.mdc`. Output is spec text, never code.

## Workflow

```
- [ ] 1. Name one behavior (e.g. "issue links", "sprint move")
- [ ] 2. Query context7 for the documented contract
- [ ] 3. (Optional) Observe shapes on a licensed instance with REA
- [ ] 4. Append a spec section with sources
- [ ] 5. Open tickets for it with the ticket-processing skill
```

**Step 2 — documented contract.** Call context7 `query-docs` with
`/websites/developer_atlassian_cloud_jira_platform_rest_v3` and one concept per query
(endpoint, request body, success code, error codes). Up to 3 queries per behavior.

**Step 3 — observed shapes (licensed instance only).** With Chrome running with a
debugging port and the page open:

```bash
rea inspect-web-page http://127.0.0.1:9222 TARGET_ID --include-json-body-shapes --json
```

Keep only key names and value types. Do not use `--include-script-sources`,
`export-web-scripts`, or `recover-javascript-sources` on Atlassian targets.

**Step 4 — spec section.** Use this template in `tracker/spec/jira-rest-v3.md`:

```markdown
## <Behavior>
Source: context7 <library id> (<doc page>) | REA shape capture <date> | 내부 정의
- Endpoint: METHOD /rest/api/3/...
- Request: ...
- Success: <code> + body shape
- Errors: <code> when ...
- Tracker decision: what we keep, simplify, or skip
```

## Done when
- Every statement has a source or is marked `내부 정의`.
- `node harness/checks.mjs spec` passes.
