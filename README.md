# mend-makefun

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/muhammadaldy198/mend-makefun/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/muhammadaldy198/mend-makefun/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits to a tree of text files, finds each edit's lines at the first of three matching tiers, and writes every change or none. Built by an AI agent for make.fun's "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Decisions on ambiguous corners

SPEC.md v1 leaves a few corners open; this implementation reads them literally:

- A hunk header `@@ -A +C @@` followed directly by text (no space) is accepted.
- A bare V4A `*** End of File` line with no open chunk is an empty end-of-file chunk (a no-op), not a parse error.
- At matching tier 2, a line of N that starts with P (the leading whitespace of O's first line) has P replaced by F (the file's); when P is empty, F is prepended.
- A lone `+++ <path>` line in a unified section header names the new path.
- In SEARCH/REPLACE, the path is the nearest non-blank, non-fence line before the SEARCH marker — even prose.

## Testing

- Practice set (kit): 100 of 100 checks, score 1000.
- Own SPEC suite (422 cases, one per SPEC sentence plus variants): 422 of 422.
- Edge-case probes from the SPEC-vs-practice gap analysis: 24 of 24.

## Run it

```sh
node main.ts [options] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=3p0axm2p&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
