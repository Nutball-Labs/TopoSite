---
description: Pause the current work session — named (keyphrase) or unnamed (quick block / full pause).
argument-hint: [keyphrase]
allowed-tools: [Read, Write, Edit, Bash, AskUserQuestion]
---

# /session-pause — Pause a Work Session

## Shared Setup

Derive the project slug from the current working directory: replace every `/` with `-` (leading `-` included).

Example: `/z/Nutball-Labs/CamClops` → `-z-Nutball-Labs-CamClops`

Memory directory: `/home/iceberg/.claude/projects/<slug>/memory/`

**MEMORY.md is already loaded in the system-reminder context — do NOT re-read it unless truncated.**

**For named pause (keyphrase provided in `$ARGUMENTS`): skip the MEMORY.md read entirely.** The Edit tool can use the in-context version; no Read needed.

---

## Step 0 — Keyphrase

Extract everything after "pause" from `$ARGUMENTS` and strip leading/trailing whitespace. That is the keyphrase.

**If a keyphrase was provided in `$ARGUMENTS`:** use it directly, no prompting. Derive the filename slug by replacing spaces with `-`. Proceed immediately to the **named pause flow**.

**If no keyphrase was in `$ARGUMENTS`**, check the conversation context:

- **If the immediately preceding Claude turn already output the keyphrase prompt** (i.e. ended with "Enter a keyphrase…" line): treat the user's current reply as the keyphrase. Empty reply, "none", or whitespace-only → unnamed pause. Any other text → named pause with that text as the keyphrase.

- **Otherwise (first invocation, no prior prompt):** output exactly this one line and stop — do not call any tools, do not proceed further this turn:

  ```
  Enter a keyphrase to label this pause session, or press Enter for no keyphrase:
  ```

- **Keyphrase present →** run the **named pause flow**.
- **No keyphrase →** run the **unnamed pause flow**.

**Keyphrase rules:** any printable characters; max 32 characters; strip leading/trailing whitespace. For filenames, derive a slug by replacing spaces with `-` (e.g. "Building dump config" → `Building-dump-config`). The original keyphrase is preserved inside the file's frontmatter.

---

## Named pause flow

No prompting — derive everything from conversation context and write immediately.

### Step 1 — Write Paused-Session-`<slug>`.md

Get current datetime via `date "+%Y-%m-%d %H:%M"` (Bash).

Populate the file from conversation context — no questions asked. **Be terse: 1 line for In Progress, 2-3 bullets max for Context / Notes.** Only capture what's needed to resume cold:
- **In Progress:** one-line summary of what was mid-flight
- **Context / Notes:** only half-done state, blockers, or non-obvious gotchas — omit anything obvious from the code or MEMORY.md

Create or overwrite `Paused-Session-<slug>.md` using the **Paused-Session format** below.

### Step 2 — Update MEMORY.md

Add a pause note to the session record:
```
- Session paused: YYYY-MM-DD HH:MM [keyphrase: <keyphrase>]
```

Add or update the MEMORY.md index entry:
```
- [Paused: <keyphrase>](Paused-Session-<slug>.md) — paused YYYY-MM-DD HH:MM
```

### Step 3 — Report

```
Session paused as '<keyphrase>'. Paused-Session-<slug>.md saved.
Use /session-resume to pick it back up.
```

---

## Unnamed pause flow

### Step 1 — Quick block or full pause?

Use AskUserQuestion:

> **"Quick block or full pause?"**
> - **Quick block — resuming shortly** — just note what you're waiting on; no handoff needed
> - **Full pause — stepping away** — save state, update Next-Session.md

---

### Quick block flow

Ask (with "Other" for free text):

> **"What are you blocked on?"**
> - **Auth / login** — e.g. `gh auth login`, `gcloud auth login`
> - **Build / install** — waiting for something to compile or install
> - **Other** — free text

Get current time via `date +%H:%M` (Bash). Add a one-liner to MEMORY.md under the current session record:
```
- Blocked: YYYY-MM-DD HH:MM — <what you're waiting on>
```

Report:
```
Noted. Pick up where we left off when you're back — no state lost.
```

Do **not** write or modify Next-Session.md for a quick block.

---

### Full pause flow

#### Step 1 — Where are we pausing?

Use AskUserQuestion (with "Other" for free text):

> **"Brief note about where you're pausing? (optional)"**
> - **Skip — no note needed**
> - **Enter note** — "Other" option provides free text

#### Step 2 — Update MEMORY.md

Get current time via `date +%H:%M` (Bash). Add a pause note to the session record:
```
- Session paused: YYYY-MM-DD HH:MM [— <note if provided>]
```

#### Step 3 — Next-Session.md update

Check MEMORY.md for whether this session was tracking Next-Session.md tasks.

If yes, use AskUserQuestion:

> **"Update Next-Session.md to reflect current progress?"**
> - **Yes — update it** — collect progress notes and rewrite the file
> - **No — leave it unchanged**

If "Yes": prompt for what's in progress and what remains, then rewrite `Next-Session.md` using the format below — place the active task under "In Progress".

#### Step 4 — Report

```
Session paused. Notes saved to MEMORY.md. [Next-Session.md updated.]
```

---

## Paused-Session-`<slug>`.md format

```markdown
---
name: paused-session-<slug>
description: Paused session state for '<keyphrase>'
metadata:
  type: project
  paused: "YYYY-MM-DD HH:MM"
  keyphrase: "<keyphrase>"
---

# Paused Session: <keyphrase>

*Paused: YYYY-MM-DD HH:MM*

## In Progress
- <task being worked at pause — enough context to resume cold>

## Context / Notes
<any state, half-done work, or gotchas needed to pick up cleanly>
```

Omit "In Progress" if nothing was mid-flight. Omit "Context / Notes" if empty.

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
