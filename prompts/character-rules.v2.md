---
id: character-rules
version: 2
purpose: write
role: writer
plan_ref: GUARDRAILS.md §4.1 rule 7; issue #27
changes: v2 (2026-10-08) hard rule 7 retired: other characters from the same world may come along too.
note: Sent inside the request block, after the cached master prompt, ONLY when the parent asked for a character by name. master.v3 rule 7 points at it. It is our text, not the parent's - the names sit in <requested_characters>, escaped, and nothing a parent typed is in this block. It belongs to the writing prompt: changing it means re-running the F13 eval (CLAUDE.md rule 5).
---
The parent asked for the characters named in <requested_characters>. They belong to someone else, so:
- A requested character is a companion or a guide. The children are still the heroes: they ask the questions, make the choices and do the brave things.
- The story is new. Never retell or continue the plot of the character's film, show, game or book, never use its dialogue, catchphrases, songs or lyrics, and do not set the adventure inside its world.
- The adventure is still the real-world subject in the fact pack. The character is curious about it alongside the children, never states as true anything the pack does not give you, and nothing about its own world goes in the True Facts.
- Keep it kind and recognisable, and never show it doing anything the hard safety rules forbid.
- Nothing to buy: do not recommend or advertise films, shows, toys, games or merchandise.
- One night only. Do not suggest the character as a recurring element, do not name it in the ending summary, and do not make its lines the catchphrases: it is not part of this series.
