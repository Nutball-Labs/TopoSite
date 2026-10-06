---
description: Record an idea or deferred thought into the current project's memory and backlog without acting on it. A virtual Post-It note.
argument-hint: <idea text>
allowed-tools: [Read, Write, Edit]
---

# /postit — Record a Deferred Thought

Capture the idea in `$ARGUMENTS` as a Post-It note. Record it; do not act on it.

## Steps

### 1. Distill the idea

Before writing anything, mentally distill `$ARGUMENTS` into a clear, concise one-line summary (10–20 words). Strip filler words, restate ambiguities plainly, and use present-tense imperative phrasing where possible (e.g. "Add retry logic to file watcher" not "I was thinking maybe we could add some kind of retry"). This distilled summary is `<summary>` — use it everywhere below instead of the raw input.

### 2. Identify the project memory directory

The memory directory is `/home/iceberg/.claude/projects/<slug>/memory/` where `<slug>` is the current working directory path with `/` replaced by `-` (leading `-` included).

For example: `/z/Nutball-Labs/FlickImp` → `/home/iceberg/.claude/projects/-z-Nutball-Labs-FlickImp/memory/`

### 3. Append to CLAUDE.md Backlog (if section exists)

Read the project's `CLAUDE.md`. If it contains a `## Backlog` or `## Backlog / Shower Thoughts` section, append a new bullet to the end of that section:

```
- <summary>
```

Do not create the section if it doesn't exist — skip this step silently.

### 4. Save to project memory

Check `MEMORY.md` in the memory directory for an existing `postit` or `shower-thoughts` memory file. If one exists, append the new idea to it. If not, create `postit_notes.md` with this format:

```markdown
---
name: postit-notes
description: Deferred ideas and shower thoughts recorded via /postit — not yet acted on
metadata:
  type: project
---

- <summary>
```

If appending to an existing file, add a new `- <summary>` bullet under the existing list.

### 5. Update MEMORY.md index

If `postit_notes.md` was just created (didn't exist before), add a line to `MEMORY.md`:

```
- [Post-It notes](postit_notes.md) — deferred ideas recorded via /postit; not yet acted on
```

If the file already existed, no change to `MEMORY.md` is needed.

### 6. Confirm

Reply with exactly one line:

```
Post-It recorded: "<summary>"
```

Nothing else. Do not suggest follow-up actions, do not begin implementing the idea.
