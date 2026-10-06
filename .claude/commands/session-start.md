---
description: Start a new work session — remote/local mode, HWM tracking, Next-Session.md handoff.
argument-hint: (no arguments)
allowed-tools: [Read, Write, Edit, Bash, AskUserQuestion]
---

# /session-start — Start a Work Session

## Shared Setup

Derive the project slug from the current working directory: replace every `/` with `-` (leading `-` included).

Example: `/z/Nutball-Labs/CamClops` → `-z-Nutball-Labs-CamClops`

Memory directory: `/home/iceberg/.claude/projects/<slug>/memory/`

**MEMORY.md is already loaded in the system-reminder context — do NOT re-read it unless truncated. Use the in-context version to find:**
- The current SN high-water mark (look for "SN HWM:", "HWM:", or "high-water mark")
- Whether a remote HWM is recorded ("Current session HWM: XXXXX.R")

---

## Step 1 — Remote or local?

Use AskUserQuestion:

> **"Is this a remote or local session?"**
> - **Local** — primary dev machine; standard integer SN (e.g. `00128`)
> - **Remote** — SSH or secondary machine; use decimal suffix convention (e.g. `00128.1`, `00128.2`)

## Step 2 — HWM review

**For local sessions**, use AskUserQuestion:

> **"Current HWM is XXXXX. Change it?"**
> - **Leave as-is** — no change
> - **Increment by 1** — e.g. `00128` → `00129`
> - **Set a specific value** — user will type the new value
> - **Custom increment** — user will specify how much to add

**For remote sessions**, compute the next remote increment (last remote `.R` + 1, or `.1` if no prior remote session at this base HWM). Use AskUserQuestion:

> **"Base HWM: XXXXX — Last remote HWM: XXXXX.R. Which HWM for this session?"**
> - **XXXXX.(R+1) — next remote increment (Recommended)**
> - **XXXXX.R — reuse last remote**
> - **XXXXX+1 — increment the base** (use if this session includes a release cut)
> - **Set a specific value** — user will type the new value

If the user selects "Set a specific value", follow up with a text prompt. Update both the base HWM line and the "Current session HWM" line in MEMORY.md once confirmed.

## Step 3 — Next-Session.md check

Look for `Next-Session.md` in the memory directory. If it **exists and has content**, use AskUserQuestion:

> **"Next-Session.md has pending tasks. Pick them up?"**
> - **Yes — work from Next-Session.md** — display the file contents in a text response; note in the session start record that the user is tracking these tasks
> - **No — ignore it for now** — acknowledge and move on

If it **does not exist**: skip silently.

## Step 4 — Session start record

Update MEMORY.md — find any existing "Current session" or most recent "Session notes" entry and append a brief start note below the HWM line:

```
- Session started: YYYY-MM-DD (remote|local) — HWM: XXXXX [— picking up Next-Session.md]
```

Get date via `date +%Y-%m-%d` (Bash).

## Step 5 — Report

```
Session started (remote|local). HWM: XXXXX. [Picking up Next-Session.md. / Fresh session.]
```
