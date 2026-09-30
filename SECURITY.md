# Security

StoryTime stores the minimum about a child - first name, age, likes, an optional note, a
reading level - and nothing else (no surname, birthdate, photo or location). Every
family-scoped table is protected by row-level security; the audit and its fixes are in
`DECISIONS.md` (#127 onwards, 2026-09-29) and `PROGRESS.md`.

If you find a vulnerability, please open a private security advisory on this repository
rather than a public issue. Do not include a real child's data in a report.
