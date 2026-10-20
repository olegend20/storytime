---
id: continue
version: 1
purpose: write
role: writer
plan_ref: issue #74; DECISIONS #210
changes: v1 (2026-10-19) - the gateway cut 2 of 7 dropped writes in the 2026-10-20 eval after chapter 1 was on the page, and those stories were lost. The writer is asked for the rest of the same story instead of a new one.
note: Sent after the request, in place of "Write the story now", when a streamed write drops after a chapter reached the parent. %NEXT%, %LAST%, %WORDS%, %REMAINING%, %MIN% and %MAX% are filled in per call (not {{placeholders}}, which are rendered from config at load). <story_so_far> holds only this story's own finished chapters - never another story's text (CLAUDE.md rule 8; the owner's reading, 2026-10-19). It belongs to the writing prompt - changing it means re-running the forced-drop eval (CLAUDE.md rule 5).
---
The connection broke while you were writing this story. The reader already has its title and the chapters in <story_so_far>: they are final and cannot change. Write the rest of the same story.

- Return the same JSON object as before. `title` and `subtitle` are exactly as in <story_so_far>. `chapters` holds ONLY the new chapters, starting with chapter %NEXT%. Never repeat or rewrite a chapter that is already written.
- Pick up exactly where chapter %LAST% ends. Keep everything consistent with the chapters so far: names, who is where, what each child has done and knows, anything set up or promised, the tone and the voice. Number and style the new headings to follow the ones so far.
- The whole story, old chapters and new together, must still meet every rule and the request's length. The chapters so far have %WORDS% narrative words: write about %REMAINING% more across the new chapters and the ending line. The finished story has %MIN% to %MAX% chapters in all.
- `ending_line`, `true_facts`, `bible_suggestions` and `estimated_read_minutes` describe the whole finished story, old chapters included.

Write the rest of the story now. Return the JSON object only.
