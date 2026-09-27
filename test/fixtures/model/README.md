# test/fixtures/model/

Model responses **recorded from real API calls**, committed so the suite runs offline and
deterministically (kickoff rule 3). Layout: `<purpose>/<key>.json`, where the key is a
hash over everything that changes model behaviour — model, system blocks, messages, tools,
`max_tokens`, `output_config`, `thinking`.

Record or re-record:

```bash
LIVE_API=1 RECORD_FIXTURES=1 pnpm test
```

**A prompt edit changes the key, so it misses the cache and the test fails with a
`MissingFixtureError` naming the record command.** That is deliberate: it makes a prompt
change visible in the diff instead of silently reusing a stale response.

Fixtures a *test* fabricates by hand go to a temp directory instead (`FIXTURE_DIR`, set in
`test/setup.ts`), so synthetic payloads can never be confused with recorded ones.

Never commit an API key. Check recorded payloads for anything sensitive before committing.
