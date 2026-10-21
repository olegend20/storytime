---
id: continue-ending
version: 1
purpose: write
role: writer
plan_ref: issue #74; DECISIONS #210
changes: v1 (2026-10-19) - from the #74 code review. A write can be cut after its last chapter, while the ending or the facts stream. prompts/continue would ask for more chapters the story does not need, so this asks only for what follows them.
note: Sent in place of prompts/continue when every chapter reached the parent before the drop (the chapters array closed, or STORY_MAX_CHAPTERS were whole). <story_so_far> holds only this story's own chapters (CLAUDE.md rule 8). Any chapters in the reply are ignored. Part of the writing prompt - changing it means re-running the forced-drop eval (CLAUDE.md rule 5).
---
The connection broke while you were finishing this story. Every chapter is written: the reader already has the title and all the chapters in <story_so_far>, and they are final.

- Return the same JSON object as before, with `title` and `subtitle` exactly as in <story_so_far> and `chapters` as an empty array: []. Do not write any chapter.
- `ending_line`, `true_facts`, `bible_suggestions` and `estimated_read_minutes` describe the whole story in <story_so_far>, and follow every rule for them.

Write the end of the story now. Return the JSON object only.
