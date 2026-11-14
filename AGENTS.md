# AGENTS.md: Standing Rules

This repo is a Chinese-language semester course archive: course materials under `课程总览/`
plus `站点/`, a self-built static reading site. Reference docs:
[维护条例.md](./维护条例.md) (principles), [维护细则.md](./维护细则.md) (procedures,
rules there yield to 维护条例 on conflict), [PRINCIPLES.md](./PRINCIPLES.md) (design
discipline), [STATE.md](./STATE.md) (live state). Progress notes live in
`.kimi-code/handoff.md` (not committed); read it before starting work.

## Push

The only write path is SSH through the akr FIDO2 agent (a hardware security-key
agent whose keys live in GitHub as SK credentials): every push triggers a phone
approval, and the push completes only when the owner taps Allow. Two fine-grained
read-only gh tokens cover reading (HTTPS push → 403): `ArchivalEra` is the owner
account, `PlumHelper` the node account. GitHub times out on direct connections; the
proxy at `127.0.0.1:2080` is required (HTTPS via `~/.gitconfig`, SSH via ProxyCommand
`socat - PROXY:127.0.0.1:%h:%p,proxyport=2080`; proxy setup appears once here and is
assumed in the push block below).

Before pushing: run the code-review skill on your own changes, then write the change
summary + review conclusion into the **final output of your conversation** (the commit
message carries them too), and stop. wo-u does not carry approvals — it is only for
task dispatch and ruling broadcasts. The owner patrols conversations, reads the final
output of each, and replies with approval; push only after that. A push without the
review conclusion in its commit message is ignored. Do not run experimental pushes.

Local gates must pass before push. The remote is split into two URLs (daily `git fetch`
/ `git pull` then run with zero approvals; only push triggers the phone):

- fetch = `https://github.com/ArchivalEra/S26-1_202609.git` (read-only PAT via gh
  keyring, silent)
- push = `ssh://git@github-ArchivalEra/ArchivalEra/S26-1_202609.git` (SK key + MFA)

**Any fetch through an `ssh://` URL triggers a phone approval — forbidden.** Prefer
`gh api` for reconcile/query; `git fetch` over HTTPS is the fallback for pulling
objects; `gh repo sync` needs write access and must not be used under the read-only
PAT. Push exclusively via the `github-ArchivalEra` alias — never the bare `github.com`
form, which offers every key in the akr agent and can select the wrong identity:

```bash
export https_proxy=http://127.0.0.1:2080 http_proxy=http://127.0.0.1:2080
set -a && . reflect-hooks/Einfacht.env && set +a
git push origin <branch>
```

## Content hard rules

- **No guessing**: never fill in missing problem text, numbers, subscripts, teacher slips
  of tongue, or missing board content. Pages never contain "todo / to verify / to fill"
  phrasing. What is missing goes to a GitHub issue (open = missing, closed = filled).
  `待提供` (external material not yet arrived) is a fact and may be stated as-is.
- **Problem statements are self-contained**: every figure the problem references and every
  figure it asks the reader to produce must be visible in the problem statement. Reading
  only the statement (no expanded panels) must be enough to solve the problem.
- **Solutions are self-contained**: the full procedure lives in the "完整解答" layer; never
  push steps to another page ("see entry X", "full derivation elsewhere" are violations).
  Machine gate: `站点/plugins/solution-selfcontained.test.mjs`.
- **Three content gates, in order** (homework / analysis intake):
  1. Anti-inhuman-analysis: any "try, adjust, cleverly see" step = unfinished work.
  2. Independent recalculation: a subagent that has never seen the solution recalculates
     every answer from the problem statement alone; it owns answer values.
  3. Dependency and process review: a different subagent attempts the problem with only
     the statement plus content pointed to by the dependency table; it owns dependencies
     and step wording, and may edit them directly (answer values still belong to gate 2).
- **status has two values only**: 开课 (course in session) or 结课 (course ended). It
  describes whether the course is still being taught, not material completeness.
- **Whitelist is exact**: `.gitignore` is `*` → `!*/` → per-file `!/full/relative/path`;
  no wildcards. Whitelist a new file before `git add`.
- **Index in, index out**: any change under `课程总览/<course>/<category>/` must update
  that category's `index.md` in the same commit, cascading up to `课程总览/index.md`.
- **handoff is updated as needed** (mandatory-freshness gate is off): record only what
  the next session must know, not construction logs. To re-enable the gate, export
  `HANDOFF_FRESHNESS=1`.
- **push is the end**: never wait for CI or poll it. CI (`deploy.yml`) covers build +
  site tests only, never Einfacht gates; gates run in local commit/push hooks only.
  "CI green" does not mean "gates green".
- Transcripts are `.txt` files; read them directly. `.githooks/extract-transcript.py` was
  only for early `.doc → .txt` conversion.
- **Raw classroom transcripts never enter the repo** (teacher and student privacy): local
  copies stay in `课程总览/<course>/原始资料/` or `/mnt/hdd/study/<course>/原始资料/`,
  untracked, never whitelisted, never pushed. The repo stores only `原始资料/index.md` entries (filename,
  nature, SHA-256) plus the cleaned notes.
- **`/mnt/hdd/study/` is the out-of-repo inbox**: new transcripts and photos land at its
  root and must be filed into `<course>/原始资料/` the same day (photos go through
  `.githooks/prepare-photos.py` before being dispatched to subagents). Files sitting at
  the root mean unfiled material that search and indexes will miss. Originals already
  archived as JXL may be deleted after hash verification. Gate `zreflect/check_study.py`
  blocks stray root files and any tracked `study/` content at commit time.
- `.kimi-code/` is never committed. The plugin protocol stack's source of truth lives in
  `.kimi-code/学习通API/protocol/`; `站点/dist` must not expose upstream semantics.

## Figures

New or changed figures (`站点/图库/*.figures.txt`, `:::figure`) require an independent
image-reading review: give the reviewer only the figure and its caption, and have it
report whether each gate is decidable, what the letters mean, where intermediate
quantities come from, and whether the figure could cause a wrong answer.

Layout defects (lines crossing boxes, text cut by lines, wrong orientation, piled-up
labels) — stop immediately: do not tweak geometry constants, do not add masks. Fixing
the same spot twice means the approach is wrong; follow
`.kimi-code/需求-图元渲染方案选型.md` (need live components, analogy: MathLive).

## Fact system (Einfacht)

Numbers are produced once: counts live in `FACTS.json`; documents reference them as
`[[key]]`. Machine blocks are rendered by
`python3 zreflect/facts.py --render-doc STATE.md` — never hand-edit; retracts value
changes only via `--accept-changes=k1,k2` and only when the number truly changed.
Gate: `python3 zreflect/registry.py --run commit` (off gates are listed separately;
"not checked" is not "passed").

Running gates by hand requires the env first, otherwise `REFLECT_MEASURE_MODULE` is
empty, collection falls back to a stub, and `check_facts` / `check_facts_replay` /
`check_readme_sync` all false-fail:

```bash
set -a && . reflect-hooks/Einfacht.env && set +a && export PYTHONPATH=zreflect
python3 zreflect/registry.py --run commit
```

The hook path (`reflect-hooks/gate.py` inside `git commit`) loads env itself; only
hand-typed commands need the prefix.

Retracted claims go to `retractions.json`; known stale hand-copied values are blocked by
`invariants.json`. Open questions in `questions/*.md` each carry `**Status:**` and a
distinguishable `**Settling:**`. Read `STATE.md` before starting work.

Before committing: `python3 .githooks/update-readme.py --worktree`,
`python3 .githooks/check-markdown.py`, `python3 .githooks/test-update-readme.py`,
`git fsck --no-progress`.

## Writing style

Chinese, plain statements, no self-defense. Mechanical procedures over clever tricks;
clever shortcuts only as cross-checks; verification must be independent. Writing-class
pages (exam prep, walkthroughs, course index summaries, README fragments, issue bodies)
lead with the conclusion and never drop numbers, conditions, negations, scope, or
attribution. For site visual or interaction problems, test in a real browser — do not
guess.
