# claudecodeui — personal fork workflow

Gitignored, local only. Repo-wide engineering rules are in the tracked `AGENTS.md`.
Upstream `siteboon/claudecodeui`, fork `materemias/claudecodeui` (`origin`).

Everything here is operational, because this file is injected into every session. History and
rarely-needed recipes — restacking, backup refs, why the stack looks like this — are in
`CLAUDE-history.md` beside it, read on demand.

## Start here — before editing anything

Two rules, no exceptions:

1. **Every coding session works on a branch.** Continue an existing one (`./stack ls` lists them)
   or start a new one cut from `upstream/main`. Never work in this checkout — it sits on
   `my/daily`, which is not a branch you develop on.
2. **No session commits to `my/daily`, and no hand merges into it.** Only `./stack daily` writes
   that ref, and only as reconstruction merges; a conflict it stops on is finished with
   `./stack daily --continue`. To deploy a fix locally, commit it on its own branch and rebuild.

So every change starts on its own branch, cut from `upstream/main`, in its own worktree:

```bash
./stack ls                      # what exists; read this before deciding anything
./stack new fix/<name>          # branch + worktree at ../claudecodeui.<name>, from upstream/main
cd ../claudecodeui.<name>       # do the work here
```

`stack` is on PATH (`~/.local/bin/stack` → this checkout) and runs from any worktree; `./stack`
works too, because every worktree gets a symlink to it. The script and `stack.tsv` are untracked
and listed in `.git/info/exclude`, so they appear in no `git status`, no tracked-file listing and
no PR diff — a tool absent from every diff is still the tool this fork is driven by. `stack help`
prints the rest, and `stack setup` re-seeds a checkout that is missing any of it.

Editing `my/daily` in place is never the small path, however small the fix. `./stack daily`
rebuilds that ref with `git switch -C my/daily upstream/main`, so an edit made here belongs to no
branch, can never be pushed or reviewed, and disappears at the next rebuild.

Two hooks enforce it, because git splits the cases: `.git/hooks/pre-commit` refuses ordinary
commits, and `.git/hooks/pre-merge-commit` refuses a hand merge — git invokes the second, not the
first, when a merge resolves cleanly, so one hook alone leaves `git merge <leaf>` wide open. The
only thing either accepts is `STACK_DAILY=1`, which `./stack daily` exports.

There is deliberately **no "a merge is in progress, so this must be the rebuild" exemption.**
Merge state is not evidence of origin: a refused hand merge leaves `MERGE_HEAD` behind, and
aborting a conflicted rebuild then re-merging the same leaf by hand reproduces the same
`MERGE_HEAD` sha, so any check keyed on it can be replayed. That is why finishing a conflict is a
`stack` subcommand — `./stack daily --continue` commits the merge and resumes the leaves after it
— and why a plain `git merge --continue` on `my/daily` is refused.

`--continue` is not a free pass either: a run that stops on a conflict records the leaf and the
`HEAD` it stopped at in `.git/stack-daily-run`, and the continuation requires that file, checks it
against `MERGE_HEAD` and the current `HEAD`, then consumes it. So `--continue` cannot be aimed at
an unrelated merge, and cannot run at all after an abort or a finished run. What it does **not**
prove is that *this* merge is the one the run started — recreate the same merge by hand and the
recorded shas match again. The boundary that holds is narrower and worth stating plainly: nothing
writes `my/daily` except `stack`, and anything ad hoc that gets in is erased by the next rebuild.

Uncommitted edits no hook can protect: snapshot them with `git stash create` (which prints a sha
and changes nothing) before any branch switch.

## How a session finds this file

A session reads what its harness discovers, and the two used here do not look in the same place:

| harness | project file it reads |
| --- | --- |
| Claude Code | `<checkout>/CLAUDE.md`, walking up from cwd |
| omp, natively | `<checkout>/.claude/CLAUDE.md` **only** — its `claude` provider has no ancestor walk-up and never reads a root `CLAUDE.md`. The tracked `AGENTS.md` it also loads covers backend architecture and says nothing about branches. |
| omp, with the local extension | `~/Sync/work/projects/omp-extensions/claude-md.ts` (enabled in `~/.omp/agent/settings.json`) injects root-level `CLAUDE.md` from cwd up to the repo root, skipping any whose realpath matches an already-discovered alias (`.omp/AGENTS.md`, `.claude/CLAUDE.md`, `AGENTS.md`) so nothing is injected twice. Its walk stops at a dir containing `.git` — a **file** in a worktree — so it reads that worktree's own root, not the main checkout's. |
| both | `~/.claude/CLAUDE.md`, in every session, whatever the cwd |

That native gap is why two sessions worked directly in `my/daily` while quoting the user-level
worktree rule back: a worktree had no `CLAUDE.md` at all, and even in this checkout omp read none.
Neither the extension nor the seeding is redundant — the extension makes a root `CLAUDE.md`
*readable* by omp, and the seeding is what puts one in a worktree to read. Measured 2026-08-18: a
fresh `omp -p` session started in `claudecodeui.omp-rich` reports exactly
`<worktree>/.claude/CLAUDE.md` and `~/.claude/CLAUDE.md` in its `<repo-rules>` block.

`stack setup` closes it for a checkout, and `stack new` runs it for every worktree it creates:

- `CLAUDE.md` → the main checkout's copy, for Claude Code
- `.claude/CLAUDE.md` → the same file, for omp
- `stack` → the main checkout's script, so the `./stack` habit works there too
- `~/.local/bin/stack`, so `stack` works from anywhere, including a checkout that has none of this

Every one of those paths is already ignored — `CLAUDE.md` and `.claude/` by upstream's own
`.gitignore`, `/stack` by the shared `.git/info/exclude` — so a seeded worktree stays clean in
`git status`. Nothing about this is tracked, and nothing reaches a PR.

The last net is `~/.claude/CLAUDE.md`: both harnesses load it in every session regardless of cwd,
and it carries three lines — read the checkout's `CLAUDE.md`, work on a branch, `stack` is on PATH
and `stack setup` restores it. That is the one that reaches a **fresh clone**, where no untracked
file exists yet, and it is deliberately a pointer rather than a copy so it cannot drift from here.

A clone on another machine has no tooling at all — not even `stack`, so `stack setup` cannot be
the first command there. Git alone is enough to break the circle:

```bash
git fetch -q origin local/tooling && git show FETCH_HEAD:stack > stack && chmod +x stack && ./stack setup
```

`setup` then restores the rest from that never-merged branch — `stack.tsv`, `CLAUDE.md`,
`CLAUDE-history.md` and both hooks, written with `git show` so nothing is staged — seeds the
exclude lines a clone never receives, and installs the PATH entry if no other clone owns it.
`stack setup --publish` creates or refreshes the branch from this checkout. It is never a ledger
row, so `stack daily` never merges it.

## Rules
- **Never create, open, or reopen a PR without the user's explicit consent in the current
  conversation.** A `feat/`, `fix/`, or `ui/` branch stays as a pushed stack leaf until the user
  asks for a PR. The ledger's `pr` value means eligible for an upstream PR, not permission to
  create one. Use `./stack pr <branch>` only after that explicit request.

- **Category is the branch prefix, and it is a decision.** `feat/` a new capability, `fix/` a bug
  fix, `ui/` a UI/UX change — all three are meant for an upstream PR. `local/` is fork-only and
  never gets one, so the prefix decides whether the work ever ships upstream. **Every branch
  names its category, and a session that is not certain which one asks the user rather than
  picking.** `./stack new` enforces it: a bare name or an unknown prefix prompts for the category
  on a terminal (with what each one means) and refuses outright when there is no terminal to ask
  on, so no branch is ever created with a guessed intent.
- **`stack.tsv` is the ledger and `./stack` reads it.** Every branch has a row: what it was cut
  from, and whether it is `pr` or `local`. A branch with no row is invisible to the rebuild.
- **PR numbers are not stored in the ledger.** `./stack ls` reads them from GitHub on every call,
  so that column cannot go stale, and it shows live state (`#1143 OPEN`) rather than a bare
  number. This branch has already had a PR closed and reopened under a new number
  (#1076 → #1143); a stored id would still be reporting the dead one. The answer is cached in
  `.git/stack-pr-cache.tsv` so `ls` still works offline — a cached row is printed with a
  trailing `~` (`#1143 OPEN~`), which is the only time the number could be wrong.
- `my/daily` = what you run: `upstream/main` + every leaf, rebuilt not rebased. **No session
  commits on it, and no hand merges into it** — only `./stack daily`, and only merges. A fix
  committed there has to be applied twice, diverges, and dies at the next rebuild.
  `.git/hooks/pre-commit` and `.git/hooks/pre-merge-commit` enforce this.
- Every development branch commits from its own linked worktree. The main checkout stays on
  `my/daily`; the same hooks reject commits and merges from any other branch checked out there.
  `stack new` creates a new branch worktree, and `stack wt` restores one for an existing branch.
- A branch marked `pr` in the ledger remains branch-only until the user explicitly requests a
  PR. Once that PR exists, every later push lands in it immediately. Force-push only with
  `--force-with-lease`.
- `local/` branches are still pushed to `origin` — as offsite backup, never as a PR head.
- `origin/main` is an exact mirror of `upstream/main`. `stack sync`, `stack new`, a fresh
  `stack daily`, and `stack pr` fetch both remotes and update the fork with a force-with-lease
  before continuing.

## Day to day

```bash
./stack ls                                # every branch, live PR state, my/daily, its worktree path
./stack sync                              # mirror fresh upstream/main to origin/main
./stack new fix/some-bug                  # branch + worktree from upstream/main, row appended
./stack new ui/thing feat/omp-provider    # …or stacked on a parent, when it needs one
./stack wt fix/some-bug                   # check an existing branch out in its own worktree
./stack wt fix/some-bug --teardown        # drop that worktree again; the branch is untouched
./stack pr fix/some-bug                   # push + open PR, only after explicit user consent
./stack dev fix/some-bug                  # hot-reload dev pair for that worktree; pm2 untouched
./stack daily                             # rebuild my/daily, build, tests, restart pm2 if needed
./stack daily --quick                     # same, skipping the suite
./stack daily --continue                  # finish the conflict a stopped rebuild left, then resume
./stack audit                             # replay every rebuild merge with rerere off, classified
```

`new` creates the worktree at `../claudecodeui.<name>` with `node_modules` symlinked and
excluded, then appends the ledger row — replace its `TODO` note. A base must be `upstream/main`
or a branch already in the ledger; **`my/daily` is rejected**, because a branch cut from it
embeds every other leaf's merge commits (see E, below). Nothing else writes the ledger: when a
PR lands, delete its row by hand (and restack any child first, below).

`wt` is the same outfitting for a branch that already exists — the ledger is not touched, only a
checkout appears. **Tear it down when the task is done.** A branch needs no worktree to be a
leaf: `stack daily` merges refs, so the rebuild, the PR and the merge order are all unaffected by
whether the branch is checked out anywhere. Teardown never passes `--force`, so a worktree
holding a modification or an untracked file is refused with the paths named (and a `stash apply`
sha when the change was tracked) rather than removed — cleanup cannot lose work. Recreating one
costs a second, so `./stack ls` showing `-` in `WORKTREE` is the resting state, not a gap.

Both `stack` and `stack.tsv` are untracked and listed in `.git/info/exclude`, so they can never
reach a commit or a PR diff.

## Rebuild `my/daily`

`./stack daily`. What it encodes, so you don't have to remember it:

- Merges **leaves only**, computed from the ledger's `base` column: a parent is already an
  ancestor of its children, and merging a branch twice is how you get a conflict with no side to
  pick. The old hand-maintained `LEAVES=` line is gone — parentage is data now.
- **File order in the ledger is merge order, and it is load-bearing:** `feat/omp-rich-history`
  before `ui/interrupted-turn-notice`. Both add a branch to the same `MessageComponent` ternary
  and a member to the same `MessageKind` union.
- One merge at a time. `git merge A B C` picks the octopus strategy, which aborts on any conflict
  without staging anything, so rerere records nothing.
- `git merge` exits non-zero whenever a conflict *happened*, even after rerere staged every
  resolution. `daily` looks for unresolved paths and leftover markers; finding none it commits
  and moves on, then names the merges it replayed. On a genuine conflict it stops: resolve,
  `git add -u` (**never `-A`**), then `./stack daily --continue`, which commits that merge and
  carries on with the leaves after it. A plain `git merge --continue` is refused by the hook.
- Tracked changes are refused up front; the checkout would otherwise stop halfway.
- The first leaf fast-forwards, so five leaves make four merge commits. A fast-forward authors
  nothing and the tree is unaffected — don't go looking for the missing one.
- Nothing retires a leaf for you. GitHub squashes, so a merged PR's tip never becomes an
  ancestor of `upstream/main` and `--is-ancestor` cannot see it.

The conflicts it hits, and which side each takes (rerere holds every one of them except the
first, which it structurally cannot — re-measured 2026-08-18 against upstream v1.37.2):

- `OmpLogo.tsx`, merging `feat/omp-rich-history` — **a file-location conflict, not a content one,
  so rerere can never cache it and every rebuild stops here.** Upstream renamed
  `src/components/llm-logo-provider/` to `llm-provider-logo/` in 1.37.2; the branch adds a file
  into the old name. Finish it with `git add src/components/llm-provider-logo/OmpLogo.tsx` — git
  has already placed the content at the new path — then `./stack daily --continue`.
- `notification-orchestrator.service.js`, merging `feat/omp-rich-history` — **keep both**, and
  re-open the doc comment: upstream's `notifyBackgroundWorkCompleted` and C's `@param` block for
  `notifyRunFailed` share the `/**` above them, so a naive keep-both leaves the `@param` lines
  with no opener.
- `useChatSessionState.ts` and `useSessionStore.ts`, merging `fix/chat-stream-sealing` — both are
  dependency arrays. Keep exactly the identifiers that still exist after the merge:
  `resetStreamingState` and `refreshFromServer` are gone, `updateThinking` and
  `discardRealtimeMessage` are new.
- `server/shared/types.ts` and `MessageComponent.tsx`, merging `ui/interrupted-turn-notice` —
  **keep both.** C's omp advisor note and the interrupted-turn notice are different rows. The
  ternary needs care: the conflict cuts the advisor branch mid-JSX, so a naive keep-both drops its
  two closing `</div>`s and the file stops compiling.
- `ChatInterface.tsx`, merging `fix/ws-resume-and-reconnect`.
- `package.json` and `chatFormatting.ts`/`.test.ts`, merging `fix/chat-latex-escaping` — take
  upstream's `test`/`test:client` scripts (its client glob already runs the branch's file), take
  the branch's math-protection functions, and union the two test suites into one file.
- `AppContent.tsx`, merging `feat/running-sessions-linux` — a React import line. Take the longer
  side (`useCallback, useEffect, useState`).
- `SidebarFooter.tsx`, merging `local/mobile-sidebar` — import paths only. Take upstream's
  `shared/utils` and `shared/types`; 1.37.2 retired `constants/config` and `types/sharedTypes`.
- `ProtectedRoute.tsx`, merging `fix/pwa-cold-start-session` — keep the `resolveAuthView` import;
  the file below the conflict calls it.

## Before pushing a feature branch

```bash
B=feat/back-opens-session-list
git diff "upstream/main...$B" --name-only   # only this feature's files?
git log --oneline "upstream/main..$B"       # only this feature's commits?
./stack ls                                 # the PR it actually points at, and its state
```

## Serving, and when a restart is actually needed

pm2 process `claude-code-ui-fork` runs `~/bin/claude-code-ui-fork-launcher.sh`, which `cd`s
into this checkout and serves **built** output on `127.0.0.1:3111` with the real
`~/.cloudcli/` data.

- `dist/` is read per request, `index.html` is served `no-cache` and assets are content-hashed →
  a client rebuild is live on the next page load, with **no restart**.
- `dist-server/` is `node dist-server/server/index.js`, loaded once at process start → only a
  server change needs the process replaced.

`./stack daily` acts on that difference: it hashes `dist-server/**/*.js` after the build and
restarts pm2 only when that hash differs from `.git/stack-served-server.sha`, the stamp written
at the last restart (so a process left serving an older artifact is caught too). A client-only
rebuild prints `dist-server/ unchanged - pm2 left alone` and the page picks it up on reload.

### Developing with hot reload

`./stack dev <branch>` runs the pair inside that branch's worktree and never touches pm2:

- **client** — `vite` with HMR on `:5173`, proxying `/api`, `/ws`, `/shell` and `/plugin-ws` to
  the dev backend, so an edit lands in the open page without a reload or a build.
- **server** — `tsx watch server/index.ts` on `:3112`, reading **sources**, so a server edit
  reloads that process in about a second. Measured: touching `server/index.ts` moved the backend
  pid while `:3111` stayed up on its original pid.

Use `http://localhost:5173`, not `127.0.0.1:5173`. vite maps a loopback `HOST` to `localhost`,
which Node resolves to `::1`, so it binds IPv6 only and the v4 address is refused.

The dev backend shares `~/.cloudcli/` with the daily instance; `./stack dev <branch> --fresh`
points it at a throwaway `/tmp` DB instead. `Ctrl-C` stops both halves (`concurrently
--kill-others`). The command refuses `my/daily`, a branch with no worktree, and anything not in
the ledger.

Ports: `3111` daily (pm2, built), `3112` dev backend (watched sources), `5173` vite.

Check what is actually being served:

```bash
SYMBOL=backOpensSessionList        # any string your change introduced
ASSET=$(curl -s http://127.0.0.1:3111/ | grep -o '/assets/index-[^"]*\.js' | head -1)
curl -s "http://127.0.0.1:3111$ASSET" | grep -c "$SYMBOL"    # 0 = serving an older build
```

That check only covers the **client**. The server build is staged, and the staging is where a
rebuild silently loses: `tsc` emits into `dist-server.next/`, and only `postbuild:server`
(`scripts/promote-dist-server.mjs`) renames it over `dist-server/`. npm here runs with
`ignore-scripts=true`, so **no `pre`/`post` lifecycle script ever fires** — `npm run build`
succeeds, `dist-server.next/` fills up, and `dist-server/` keeps serving the build it already
had. On 2026-08-18 the live backend was two days stale that way while every `./stack daily`
reported success, so `fix/jwt-secret-rotation` was merged, built, tested and never served.
`./stack daily` now runs the clean and the promote explicitly; when building by hand, do the same:

```bash
rm -rf dist-server.next && npm run build:server && node scripts/promote-dist-server.mjs
pm2 restart claude-code-ui-fork    # dist-server/ is loaded once, at process start
grep -c 'INSERT OR IGNORE' dist-server/server/modules/database/repositories/app-config.js
```

A leftover `dist-server.next/` directory is the tell: after a promotion it does not exist.

### Surviving reboots

`claude-code-ui-fork` is the **only** claudecodeui app registered with pm2, and
`pm2-remias.service` (systemd, enabled) runs `pm2 resurrect` at boot against `~/.pm2/dump.pm2`.
So the fork comes back on its own and nothing else claims port 3111.

The published app it competed with is gone; that revert recipe is in `CLAUDE-history.md`.

**Run pm2 as `remias`, never with `sudo`** — a root pm2 uses `/root/.pm2` and would save to a
dump the boot unit never reads, looking successful while the reboot restores the old list.

**`pm2 save` after any change to which apps run.** The boot dump is a snapshot, not a live
view; this one had sat 3 weeks stale. Prove boot behaviour without rebooting — this is the real
thing, systemd starting the daemon from nothing:

```bash
pm2 kill && PM2_HOME=~/.pm2 pm2 resurrect && sleep 8 && pm2 list
```

That is the unit's own `ExecStart` against a dead daemon — verified 2026-08-10: port went down,
then only the fork came back, restart counter at 0, `:3111` HTTP 200. `sudo systemctl start
pm2-remias` exercises the same path one layer up (sudo is fine for *systemctl*; the warning
above is only about running *pm2* itself as root).

In that order. The unit is `Type=forking` with `ExecStart=pm2 resurrect`, so `systemctl restart`
while a hand-started daemon is alive finds nothing to fork, and the unit lands in `failed` while
the app keeps running — a state that looks broken but serves fine. `pm2 kill` first, then let
systemd own the daemon (`systemctl show pm2-remias -p MainPID` should name the God Daemon).

## rerere

**Re**use **re**corded **re**solution, enabled locally (`rerere.enabled`, `rerere.autoUpdate`).
Rebuilding replays the same merges, so the same conflicts recur; git replays the resolution you
gave the first time and stages it. Per-clone, never pushed. `git rerere forget <path>` drops a
bad one. An unseen conflict still stops for a human.

Caveat: a replayed resolution is only as current as when it was recorded, so after upstream
moves it can quietly favour the stale side while the merge looks clean. After a rebuild that
resolved a conflict on a branch with an open PR:

```bash
PR=1129        # ← replace with the PR you just rebuilt; gh never echoes the number back
gh pr view "$PR" --repo siteboon/claudecodeui --json mergeable,mergeStateStatus
```

### Auditing it — `./stack audit`

Because the replay is silent by construction, the check on it is a command rather than a habit:
`./stack audit` re-creates every merge the rebuild makes with `rerere.enabled=false` and
`merge.conflictStyle=diff3`, in a throwaway worktree, and says what each conflict *is*. Read-only:
it never writes `my/daily`, and the live tree stays untouched.

Each conflict block is reduced to what both sides did to the base, which a whole-file diff cannot
tell you — both sides of a deletion boundary also add lines elsewhere in the same file:

|it says|it means|
|---|---|
|`deletion boundary: structural`|neither side added a line; they disagree over a deletion|
|`one side adds, one deletes: pick a side`|`useChatSessionState.ts`, `ChatInterface.tsx` — the price of keeping a branch cut from `upstream/main` while another removes what it still uses. Restacking it to end the conflict is exactly what would end its PR-ability.|
|`both sides add, disjoint names`|an additive collision: two branches append to the same list, union or import|
|`both sides add, sharing: <names>`|a **hint**, never a verdict. Both sides *declare* the same name, which is how `resolveCostModel` lived on two branches for weeks. Shared field reads don't count, and a hint alone never fails the audit.|

It also checks the ledger's `base` column against reality. Ordinary drift is reported and nothing
more — upstream moves, and rebasing a branch with an open PR is a judgment call — but a fork point
that is the tip of some *other* ref means the branch was cut from that ref while the row names a
base it never sat on. That is `local/mobile-sidebar`'s wrong-base bug, and it is the only thing
that makes the command exit non-zero — a shared-name hint never does, by design.

Measured 2026-08-18: **5 files, 6 blocks, 36 lines** to answer by hand on every rebuild, against
26 rebuilds in 9 days of reflog. That is the number that decides the setting — disabling rerere
would not surface any of the causes above, it would only make `./stack daily` stop four times
before the build and the suite. Both real defects it did surface (D's duplicate `resolveCostModel`,
the sidebar's stale base) were found by *reading* a recurring conflict, and both were fixed with
rerere enabled; after each fix the conflict is simply gone from the replay.

Cache hygiene is part of the report, because nothing expired under the defaults: a preimage with
no postimage is a conflict seen and never resolved, useless on its own, so `gc.rerereUnresolved`
is 1 here (44 entries → 31 on 2026-08-18, all 18 resolutions intact). Resolutions still age out at
the 60-day default. The line comparing held resolutions to live conflicts is a **count**, not a
reachability proof: it never hashes a cache key against a current preimage, so read it as "the
cache is bigger than this rebuild needs", never as "these 13 are unreachable".

## Gotchas

- Overriding `PORT` in dev breaks `/api` with `ECONNREFUSED` — the vite proxy targets a fixed
  backend port. Change `VITE_PORT` only.
- `.gitignore` matches `node_modules/` (directory form), **not** a symlink, so a worktree whose
  `node_modules` is symlinked will have it committed by `git add -A`. Add it to
  `.git/worktrees/<name>/info/exclude`.
- **Never `git add -A` while resolving a rebuild conflict.** It stages every untracked file in the
  tree, so a scratch doc lands in the merge commit — and the next `git switch -C my/daily
  upstream/main` then *deletes* it from disk, because it is tracked in the ref you just discarded.
  Stage with `git add -u` (or name the conflicted paths). Recover a lost one from the abandoned
  build: `git show <old-my-daily-sha>:<path> > <path>`.
- Smoke-test against a throwaway DB (`DATABASE_PATH=/tmp/…`) so `~/.cloudcli/auth.db` is never
  touched; delete it afterwards.
- **An upstream release can add a dependency, and the build says so late.** 1.37.2 added
  `mermaid`; the vite build failed on an unresolvable import long after every merge had been
  committed. Install before rebuilding when `upstream/main` moved a minor version.
- **`npm ci` cannot run in this environment and destroys `node_modules` on the way out.** The
  lockfile carries a `remote` tarball URL (`void-elements` from npmmirror) and npm here refuses
  those (`EALLOWREMOTE`) — but only after it has already emptied the tree. Use
  `npm install --no-package-lock`, which resolves from the registry and writes no lockfile, so
  `my/daily` stays clean.
- **Install scripts are disabled (`ignore-scripts=true`), so native modules arrive unbuilt.**
  After any reinstall, `better-sqlite3` has no binding and *every* server test dies at
  `getConnection`. `npm rebuild` reports success and fixes nothing; the binding comes from
  `cd node_modules/better-sqlite3 && npx prebuild-install -r node`.
- Contributing rules live in the tracked `CONTRIBUTING.md` — read it rather than a copy. The one
  thing it can't tell you: `gh` cannot upload images, so UI screenshots must be dragged into the
  PR body by hand.

## The branch stack (shape only — `./stack ls` is the live view)

`./stack ls` prints the current tips, PR numbers and states; nothing below repeats them, so
nothing below can go stale. What it cannot tell you is *why* the shape is what it is.

PR #1076 was split, then **closed and reopened as #1143** — the maintainer asked for a clean PR
rather than a fifth force-push over a review thread aimed at code that no longer existed. Same
branch, same commits, new number. What was one 61-commit branch is now a stack, each branch with a
single subject:

```
upstream/main
 ├─ A  feat/shared-tool-approval-registry   shared tool-approval registry
 │   └─ B  feat/omp-provider                the omp provider
 │       ├─ C  feat/omp-rich-history        rich omp transcript UX + the /cost backend id
 │       ├─ E  feat/running-sessions-linux  agent sessions running outside the UI
 │       └─ fix/chat-stream-buffers         per-session buffers for both streamed surfaces
 │           ├─ fix/chat-stream-sealing     close a streamed row at each message boundary
 │           └─ ui/interrupted-turn-notice  say when a turn was cut off, in 11 locales
 ├─ fix/ws-resume-and-reconnect             replace a dead-but-OPEN socket; recover mid-turn
 ├─ fix/chat-latex-escaping                 escaping stops shredding LaTeX and currency
 ├─ fix/chat-row-containment                scrolled-away rows stop becoming empty boxes
 ├─ local/tool-content-folding              fold large tool content — taste, never a PR
 ├─ feat/back-opens-session-list            mobile back opens the session list
 └─ feat/agent-model-catalog                upstream's `getProviderModels` unwrap bug
```

Anything under B carries B's diff until B lands, so of those only A and B are PR-able today. The
branches cut straight from `upstream/main` are PR-able now, `local/tool-content-folding` never. A
cross-fork PR can only be based on `siteboon:main`; `./stack pr` warns before pushing one.

Why the shape is what it is — the rename that clobbered #1076 twice, why E moved off `my/daily`,
what retiring `local/ui-fixes` split into — is in `CLAUDE-history.md`, together with the restacking recipe,
the backup table and the deliberate deltas the split introduced.

## Standing lessons

- **Read the function, not last hour's snapshot of it.** `computeMerged` *sorts*
  `[...server, ...extra]` chronologically, it does not concat — so a realtime notice keeps its
  place in the turn, and "retire the notice on `complete`" would have erased the explanation for a
  gap still visible in the transcript.
- **Trace which state feeds a guard, and when it is sampled, before blaming the guard.** I filed
  #1138 against `useChatSessionState`'s `if (!isProcessing)` gate; reconnect never reaches that
  effect (`websocket_reconnected` is handled in `ChatInterface`), and the gate was passing anyway.
  What fixed the transcript hole was the `WebSocketContext` resume probe. Retracted.
- **A browser catches what tests cannot.** The `ResizeObserver` visibility fix never fired once —
  the toggled `display:none` is on an *ancestor*, and `ChatInterface` is `React.memo` with no prop
  tracking `activeTab`. It took an explicit `isVisible` prop.
- **A stale-page guard must capture its generation at render**, not read a ref at call time: a key
  alone cannot see A → B → A, and a callback held from before the switch passes every check while
  fetching the old id.
