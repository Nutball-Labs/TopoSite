---
description: End the current work session — Next-Session.md disposition and MEMORY.md update.
argument-hint: (no arguments)
allowed-tools: [Read, Write, Edit, Bash, AskUserQuestion]
---

# /session-end — End a Work Session

## Shared Setup

Derive the project slug from the current working directory: replace every `/` with `-` (leading `-` included).

Example: `/z/Nutball-Labs/CamClops` → `-z-Nutball-Labs-CamClops`

Memory directory: `/home/iceberg/.claude/projects/<slug>/memory/`

**MEMORY.md is already loaded in the system-reminder context — do NOT re-read it unless truncated. Use the in-context version to determine:**
- Whether the session was started with Next-Session.md picked up (look for "picking up Next-Session.md" in the session start record)
- Whether `Next-Session.md` currently exists in the memory directory

---

## Step 1 — Next-Session.md disposition

**If the user WAS working from Next-Session.md tasks**, use AskUserQuestion:

> **"How should Next-Session.md be handled?"**
> - **Purge it — everything is done** — delete the file; remove its MEMORY.md entry
> - **Update it — tasks remain or new ones were added** — rewrite the file with updated content
> - **Leave it unchanged** — no action

If "Update it": use AskUserQuestion (with "Other" for free text) to collect the updated task list, then rewrite `Next-Session.md` using the format below.

**If the user was NOT working from Next-Session.md (ignored it or it didn't exist)**, use AskUserQuestion:

> **"Add tasks to Next-Session.md for next time?"**
> - **No — skip Next-Session.md** — no action
> - **Yes — add taskings** — collect task list and write/update the file

If "Yes": prompt for the task list and write `Next-Session.md` using the format below.

## Step 2 — Update MEMORY.md session notes

Update the session start record or add a new session-end note. Ask the user for a one-line summary of what was accomplished if it is not evident from context.

Add or update:
```
- Session ended: YYYY-MM-DD — <one-line summary>
```

Get date via `date +%Y-%m-%d` (Bash). If the HWM was changed this session, confirm the MEMORY.md HWM line reflects the final value.

## Step 3 — Report

```
Session ended. Next-Session.md: [purged | updated | created | unchanged | skipped]. Memory updated.
```

---

## Next-Session.md format

```markdown
---
name: next-session
description: Tasks and context to pick up at the start of the next session
metadata:
  type: project
---

# Next Session Tasks

*Last updated: YYYY-MM-DD*

## In Progress
- <task actively being worked at pause/end — enough context to resume cold>

## Queued
- <task for next session>
- <another task>

## Context / Notes
<any state, half-done work, or gotchas needed to pick up cleanly>
```

Omit "In Progress" if nothing was mid-flight. Omit "Context / Notes" if empty.

After writing or updating `Next-Session.md`, update the MEMORY.md index:
- If the entry doesn't exist, add: `- [Next session tasks](Next-Session.md) — work to pick up next session; updated YYYY-MM-DD`
- If the entry exists, update its date.
- If the file was purged, remove the entry entirely.
