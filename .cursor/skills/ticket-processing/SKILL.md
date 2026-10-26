---
name: ticket-processing
description: Runs the tracker's issue → ticket → processing loop through the AI harness: registers epics, splits them into tickets and subtasks, and closes each only after its verification command passes. Use when planning or executing tracker work, adding tickets to harness/plan.json, or when the user asks to process issues or tickets.
---

# Ticket processing

The tracker is both the product and the work log. Work is driven by
`tracker/harness/plan.json` and executed by `tracker/harness/run.mjs`.

## Roles (accountIds in plan.json)

| Role | Does |
| --- | --- |
| owner | Registers epics, closes an epic when all its tickets are done |
| analyst | Splits epics into tickets and subtasks with a `verify` command |
| builder | Takes the ticket, starts progress, runs `verify`, requests review |
| reviewer | Moves to Done if `verify` passed, otherwise back to In Progress |

## Loop

1. **Issue.** Add an epic to `plan.json` (`id`, `summary`, `description`).
2. **Tickets.** Add tickets under it. Each needs a stable `id`, `type`
   (Story/Task/Bug), `summary`, and `verify` — a `node ...` argv run in `tracker/`.
   Use `subtasks` when one ticket needs several independent checks.
   Use `blockedBy: ["<ticket id>"]` for ordering; it becomes a Blocks link in the tracker.
   Mark an epic `"defer": true` to register it without processing it yet.
3. **Implement** the code for the next unfinished ticket, smallest first.
4. **Process.**

   ```bash
   cd tracker && npm run harness
   ```

   Re-running is safe: issues are matched by the `plan-<id>` label, finished tickets
   are skipped, failed ones return to In Progress with the failing output as a comment.
   Tickets blocked by an unfinished issue wait until their blocker is done; if the
   blocker fails, they are reported as on hold. A ticket without `verify`, or one the
   tracker refuses to move (for example 409 for open subtasks), is reported as failed.
5. Read `tracker/reports/latest.md`. Fix failures and repeat step 4.

## Rules
- Never mark a ticket Done by hand to get around a failing `verify`.
- A parent cannot be Done while its subtasks are open (API returns 409).
- `verify` must start with `node`; the harness refuses anything else.
- Before finishing a session: `npm run verify` must pass.
