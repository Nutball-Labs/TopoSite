---
description: Resume a paused work session — lists named pause channels and Next-Session.md; loads selected context.
argument-hint: (no arguments)
allowed-tools: [Read, Write, Edit, Bash, AskUserQuestion]
---

# /session-resume — Resume a Paused Work Session

## Shared Setup

Derive the project slug from the current working directory: replace every `/` with `-` (leading `-` included).

Example: `/z/Nutball-Labs/CamClops` → `-z-Nutball-Labs-CamClops`

Memory directory: `/home/iceberg/.claude/projects/<slug>/memory/`

---

## Step 1 — Find paused sessions

Scan the memory directory for files matching `Paused-Session-*.md`. For each file:
- Read the `keyphrase:` and `paused:` fields from the YAML frontmatter
- Use the keyphrase for display; the filename is just the slug

Also check whether `Next-Session.md` exists and has content — treat it as a resumable unnamed session labelled `(default)`.

Run: `ls /home/iceberg/.claude/projects/<slug>/memory/Paused-Session-*.md 2>/dev/null`

## Step 2 — Display session list

If no paused sessions (named or default) are found, report:
```
No paused sessions found. Use /session-start to begin a new one.
```
And stop.

Otherwise display a list sorted by datetime (newest first):

```
Paused sessions:
  GPU encoding fix   — 2026-06-05 14:30 — "figuring out QSV params"
  Lunch              — 2026-06-05 12:00 — (no note)
  (default)          — 2026-06-01 09:15 — Next-Session.md
```

## Step 3 — Prompt for selection

List each keyphrase as an AskUserQuestion option (plus "(default)" if Next-Session.md exists). The user picks one — no typing required unless there are more sessions than options allow, in which case use "Other" for free text.

Accept case-insensitively. If a typed value doesn't match, report and list again.

## Step 4 — Load and display the selected session

Read the matching `Paused-Session-<slug>.md` (or `Next-Session.md` for "default"). Output the full content to the user as context for resuming.

## Step 5 — Clean up

Delete the file. Get current datetime via `date "+%Y-%m-%d %H:%M"` (Bash). Update MEMORY.md:
- Remove the `[Paused: <keyphrase>]` index entry
- Add a resume note:
  ```
  - Session resumed: YYYY-MM-DD HH:MM — <keyphrase>
  ```

## Step 6 — Report

```
Resumed '<keyphrase>' session (paused YYYY-MM-DD HH:MM). Context loaded above.
```
