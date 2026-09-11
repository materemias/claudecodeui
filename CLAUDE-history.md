# claudecodeui fork — history and rarely-needed recipes

Split out of `CLAUDE.md` on 2026-08-18 so the always-loaded doc stays operational: this file is
read on demand, not injected into every session. It lives beside the main checkout's `CLAUDE.md`
(`~/Sync/code/claudecodeui/CLAUDE-history.md`) and is untracked like the rest of the tooling.

Come here to restack a child after a parent lands, to find a backup ref, or to ask why the tree
looks the way it does.

## Going back to the published npm build

The published `claude-code-ui` app was deleted on 2026-08-10 — it fought the fork for 3111
(`EADDRINUSE`, 288 restarts and climbing). Its launcher script still exists, so going back to
the npm build is:

```bash
pm2 delete claude-code-ui-fork
pm2 start ~/bin/claude-code-ui-launcher.sh --name claude-code-ui
pm2 save
```

## Why the stack looks like this

**One name for B.** `rebuild/omp-provider` was renamed to `feat/omp-provider` on 2026-08-12 and
the stale 61-commit branch of that name was deleted (kept at `backup/pr-1076-clobbered-2026-08-12`
until the 2026-08-24 prune — recoverable from the sha in the backup table)
along with its `claudecodeui.omp` worktree. That duplicate is how #1076 got clobbered back to 61
commits once already: a push from the stale worktree overwrote the rebuilt branch. Do not recreate
a second local ref for B.

**E was cut from `my/daily`, which is the mistake the Rules section warns about.** Its history
embedded every other leaf's merge commits, so rebuilding `my/daily` re-folded a stale snapshot of
C and silently lost C's newest commit. It now sits on B (it needs `LLMProvider` including `'omp'`),
one commit, and the rebuild is honest again.

**`local/ui-fixes` is retired.** On 2026-08-17 its 13 commits were recategorised into eight
branches, one subject each; `backup/ui-fixes-pre-recategorise-2026-08-17` holds the old tip and
`origin`'s copy is deleted. Only `local/tool-content-folding` kept the never-PR intent — that is
what the `local/` prefix means, and `./stack pr` refuses it. The other seven are real fixes:
upstream bugs filed separately (#1136 streaming buffer has no message boundary, #1137 older
history unreachable when the first page does not overflow) or repairs to fork-only machinery
(`WebSocketContext` resume probe, duplicate-connect guard, queued-draft hold, interrupted-turn
notice), each now reviewable on its own. `fix/chat-stream-buffers` and its two children sit on B
because they need omp's machinery; the rest were cut from `upstream/main`. What the split dropped
is recorded below.
## Restacking when a parent lands

Children carry their parent's diff until the parent merges. Back up first, then move only the
child's own commits:

```bash
git branch backup/omp-core-pre-restack feat/omp-provider            # or the child being moved
git branch backup/buffers-pre-restack fix/chat-stream-buffers       # its own children move too
git rebase --onto upstream/main feat/shared-tool-approval-registry feat/omp-provider
for child in feat/omp-rich-history fix/chat-stream-buffers feat/running-sessions-linux; do
  git rebase --onto feat/omp-provider backup/omp-core-pre-restack "$child"
done
for gchild in fix/chat-stream-sealing ui/interrupted-turn-notice; do
  git rebase --onto fix/chat-stream-buffers backup/buffers-pre-restack "$gchild"
done
git push --force-with-lease origin feat/omp-provider feat/omp-rich-history
```

`feat/omp-rich-history` and `feat/running-sessions-linux` have worktrees, so those rebases run in place.
The `fix/*` branches do not: rebasing one in this checkout moves HEAD off `my/daily`, so run them
in a scratch `git worktree add --detach` (or `git switch my/daily` afterwards, before the next
rebuild). Always compare the child-only diff (`git diff <parent>...<child>`) before pushing —
never replay a parent through a child. Then update the moved children's `base` column in
`stack.tsv`, and delete the landed parent's row: `./stack daily` reads parentage from there, and a
landed leaf is never retired for you. `feat/running-sessions-linux` is never pushed.

## Backups (all pruned 2026-08-24)

Pruned 2026-08-17 from 21 refs to 11, the recategorisation added one back, v1.37.2 added two
more — and on 2026-08-24 **all of them were deleted**, along with the `probe/*` refs. None was an
ancestor of a live branch, so no reachable history was lost. Until git gc takes the objects, any
of them can be recreated with `git branch <name> <sha>`:

| Branch (deleted) | Was |
|---|---|
| `backup/ui-fixes-pre-recategorise-2026-08-17` (`f6d8d4e`) | the 13-commit `local/ui-fixes` tip, before it became eight branches |
| `backup/omp-provider-pre-1143-review` (`c3d3e2f`) | B, C, D, E before the #1143 review fixes |
| `backup/omp-rich-pre-1143-review` (`5f00ac7`) | ↑ |
| `backup/ui-fixes-pre-1143-review` (`b16d1d2`) | ↑ |
| `backup/running-sessions-pre-1143-review` (`32fe23e`) | ↑ |
| `backup/omp-rich-pre-review-fix` (`bc1d754`) | B/C/D as first pushed, before the #1141 restack |
| `backup/ui-fixes-pre-review-fix` (`3a13995`) | ↑ |
| `backup/pr-1076-clobbered-2026-08-12` (`ef4865b`) | the 61-commit branch restored over #1076 by a stray push, plus the cost fix — the only copy of that history |
| `backup/my-daily-pre-split` (`ac3f56e`) | the pre-split integration tree |
| `backup/my-daily-pre-e-restack` (`387ee8f`) | the tree built from E while it still sat on `my/daily` |
| `backup/my-daily-pre-move` (`cfede31`) | ↑ older |
| `backup/my-daily-2026-08-11-pre-rebase` (`793bf65`) | ↑ older still |
| `backup/back-opens-pre-rebase` (`bfe9775`) | `feat/back-opens-session-list` before its rebase |
| `backup/mobile-sidebar-pre-rebase` (`d307270`) | `local/mobile-sidebar` before its rebase |
| `backup/inflight-my-daily-2026-08-17` (`3ed6cc6`) | `my/daily` mid-rebuild snapshot |
| `backup/pwa-pre-v1.37.2` (`125b87e`) | `fix/pwa-cold-start-session` before the v1.37.2 rebase |
| `backup/ws-resume-pre-v1.37.2` (`e5f0c45`) | `fix/ws-resume-and-reconnect` before the v1.37.2 rebase |

The probes went the same day: `probe/notice_alone` (`0ce45c3c`) and `probe/sealing_alone`
(`71654e5c`) were diagnostic isolations from the sealing/notice interaction. Their commits are
ancestors of `ui/interrupted-turn-notice` and `fix/chat-stream-sealing` respectively, so deleting
the refs — local and the origin copies pushed that morning — keeps every commit reachable.


## What the split changed on purpose

The rebuilt tree is not byte-identical to `backup/my-daily-pre-split`; it differed in 19 files
when both still sat on `0f67810c`, all deliberate (a raw diff today also carries upstream's own
v1.37.1 changes, since only the rebuild followed `upstream/main` forward):

- **Two real defects fixed.** The omp runtime passed the *app* session id where every other
  runtime resolves the provider-native one (`context.resolveProviderSessionId`), so `session/load`
  and `session/fork` both failed and resume started blank while reporting success. And abort keyed
  the run by native id but `activeOmpSessions` by app id, so `session/cancel` never reached the
  child. Both have regression tests.
- **One locator, not two.** `locateOmpSessionFile` existed twice, in the runtime and the reader,
  "kept in sync by hand" for a JS/TS boundary that no longer exists. Now `omp-session-files.ts`.
- **Compliance repairs** per `.agents/skills/backend-module-standards`: omp tests moved to
  `server/modules/providers/tests/`, exports at declarations instead of a trailing `export {}`
  block, consumer comments on every exported symbol, no module-local `utils.ts`.
- **Lane A gained tests** (`server/shared/tests/tool-approval-registry.test.ts`, 15 cases) and its
  expiry sweep now cancels a stalled waiter instead of dropping it. Two further bugs came out of
  #1141's automated review and were amended into the same commit: `receivedAt` is coerced to a real
  `Date` at registration (a string crossing the JS boundary made `instanceof Date` fail, so the
  sweep read the entry as "unknown age" and never expired it), and `resolveToolApproval` now
  consumes the entry before settling it, so a duplicate or late `chat.permission-response` cannot
  deliver a second decision.
- **`notice` moved from C to D.** Nothing in A+B+C ever produced a `notice` message — only D's
  interrupted-turn path does — so the kind, the `isNotice` field, the normalization case and the
  render branch all live in D now. C keeps `advisor_note`, which its omp reader does produce.
- **The `/cost` provider fix lives on C, not B.** `5f00ac7` threads omp's recorded backend id
  (`zai`, `anthropic`, …) through `provider-token-usage.service.ts` into `/cost`, so the report
  names the real backend instead of the app provider `omp`. It has **zero dependency on C** — none
  of C's other commits touch any of its five files — and by subject it completes B's own token
  telemetry rather than the transcript UX. It sits on C only because B was already under review at
  5 commits. Consequence: **B as reviewed reports `omp` as the `/cost` provider.**
  Move it down to B if that matters more than another force-push.
- **The recategorisation dropped a duplicate.** Splitting D by subject exposed that its
  `commands/services/command-model.service.ts` (plus its test) re-implemented what B's own
  `resolveCostModel` already does, so it was dropped rather than given a branch. The tree now
  differs from the pre-recategorisation build (`1de0b9cc`) in exactly four files: that service,
  its test, `commands.routes.ts` back on B's path, and a corrected comment in
  `useChatComposerState.ts`. `/cost` still reports the model a turn actually ran on — that
  behaviour was always B's.

Verified 2026-08-17 on `my/daily` `afc432e0` (on `0d51774912`, v1.37.1), rebuilt by `./stack
daily` with its exit status captured explicitly (0): build clean, **341/341** server tests
serialized, pm2 restarted and serving it. Re-running the script leaves the tree byte-identical,
which is what proves it encodes the recipe rather than a variation of it. The count moved 345 →
341 with the dropped duplicate service's test file. For a per-lane number, run the suite in that
branch's own worktree.

On 2026-08-17 `feat/ui-fixes` became `local/ui-fixes` and was then retired into eight branches,
and `feat/local-running-sessions` became `feat/running-sessions` (the old name read as if the
*branch* were local). The `origin` ref for the first was deleted; older comments and PR bodies
still say `feat/ui-fixes`. On 2026-08-18 that branch was renamed again to
`feat/running-sessions-linux`, because the detector only reads `/proc` and returns nothing on any
other platform. It had never been pushed, so the rename touched only the local ref and the ledger.

## Upstream v1.37.2 (2026-08-18): one leaf retired, two rebased

`upstream/main` moved `0d517749` → `677b7ba4` (v1.37.2) and rewrote `useChatSessionState.ts`,
`ChatInterface.tsx` and `useSessionStore.ts`, shipping its own history paging (`hasMore`,
`fetchMore`, a bridge page in the store, `captureScrollRestoreState` in the hook) plus an
`isActive` gate and a `messageHistoryRefreshCoordinator`. The first rebuild after the fetch stopped
with **11 conflict blocks** merging `fix/chat-history-paging` and **6 (115 lines)** merging
`fix/ws-resume-and-reconnect` — both branches patch code that no longer exists.

- `fix/chat-history-paging` was **retired**: its ledger row is gone, so `stack daily` no longer
  merges it. It cannot simply go back — its six commits patch a file 1.37.2 rewrote, and putting
  the row back reinstates an 11-block conflict on every rebuild. The branch ref survived until
  2026-08-24 (`7dc0b9e3`, recoverable until gc); the per-commit comparison against 677b7ba4
  (2026-08-18) said the retirement costs more than the
  first look suggested:
  - `34af2318` (sessions opening parked at the top) — **upstream fixes it**, by a different
    mechanism: a `pendingInitialScroll` reset on session change, gated on
    `isLoadingSessionMessages`, then an rAF tick that pins `scrollTop` while the height grows.
  - `01bcb7ca` (hidden-tab paging storm) — moot: upstream has **no auto-fill loop at all**, and
    gates bounded history HTTP on an `isActive` prop plus the coordinator's `canRequest`.
  - `66cec464` / `7dc0b9e3` (auto-fill, and re-arming it on return) — **behaviour lost.** Nothing
    upstream pages until the viewport overflows. A transcript whose first page cannot scroll is
    still reachable only because `ChatInterface` forwards `onWheel`/`onTouchMove` to `handleScroll`,
    whose top gate can call `fetchMore` without a scrollbar. That is a gesture, not a fill.
  - `707b1f63` (a reading gesture losing to the deferred follow-scroll) — **defect still present
    upstream**: `setTimeout(scrollToBottom, 50)` is scheduled with no timer ref and never
    re-checks near-bottom, so a scroll up during those 50ms is overridden. The branch's
    grow-the-tail-window-while-reading effect has no upstream counterpart either.
  - `c787d935` (epoch/generation guard) — **defect still present upstream**: `fetchMore` applies
    its result after the await with no post-await identity check, and `loadAll` compares only a
    session id, so A → B → A still passes every guard.

  So the two worth porting onto 677b7ba4 are `707b1f63` and `c787d935`; the auto-fill is a
  deliberate loss unless someone rebuilds it against the new hook.
- `fix/ws-resume-and-reconnect` was **rebased onto `677b7ba4`** (backup:
  `backup/ws-resume-pre-v1.37.2`). Upstream had meanwhile written its own
  `handleWebSocketReconnect` that awaits `requestLatestMessages` *before* subscribing — exactly the
  ordering `d7c66e5a` warns about — so the port keeps upstream's API and `isActive` deferral while
  restoring the branch's order: subscribe first, refresh after. The mid-turn recovery keeps its
  `refreshTokenUsage` helper and drops the `!isProcessing` gate as before.
- `fix/pwa-cold-start-session` was **rebased** too (backup: `backup/pwa-pre-v1.37.2`), because its
  new `AuthUnavailableScreen.tsx` imported `constants/branding`, which 1.37.2 moved to
  `shared/constants`. Nothing conflicted — the merge was clean and the *build* caught it. It then
  gained `06d42ba3`: `classifyAuthProbe` was ending the session on **any** 401/403, which
  reintroduces the same bug one layer out. `authenticateToken()` sets `X-Auth-Error` on every
  rejection it makes (`auth.middleware.ts:52,65,86,97`, exposed through CORS in `index.ts:123`),
  and platform mode answers 500 rather than 401, so a bare 401/403 is always someone else's
  verdict — Cloudflare Access answering an unauthenticated fetch through the tunnel, a WAF, a
  proxy with its own auth. The header is now the whole test. Cost of being wrong the other way: a
  genuinely dead token behind a server too old to send the header parks on the reconnecting screen
  instead of the login form, and the 5s retry keeps probing.

Verified on `my/daily` `188c8287` (on `677b7ba436`, v1.37.2): build clean, **353/353** server
tests, the served bundle's probe reduced to
`e.ok?"authenticated":e.headers.get("X-Auth-Error")?"rejected":"unavailable"`.

`npm test`'s default parallel workers fail `server/modules/agent/tests/agent.routes.test.ts` with
`Unable to deserialize cloned data` — that reproduces on a pristine `upstream/main` (262/263), so
run the suite serialized when you need a real number:

```bash
npx tsx --tsconfig server/tsconfig.json --test --test-concurrency=1 \
  "server/**/*.test.ts" "server/**/*.test.js"
```

## How a session finds this file

A session reads what its harness discovers. The two harnesses use different sources, and omp also applies provider shadowing:

| harness | project file it reads |
| --- | --- |
| Claude Code | `<checkout>/CLAUDE.local.md` (tracked bootstrap), then `<checkout>/CLAUDE.md` when setup has seeded it, walking up from cwd |
| omp | A standalone `CLAUDE.md` and `AGENTS.md` are candidates while walking from cwd to the repository root. At this repository's root they share a depth, and the current installation injects `AGENTS.md`; its workflow section points the session to this file before editing. |
| omp local extension | `CLAUDE.local.md` from cwd through the repository root, if present. The enabled `claude-local-md.ts` extension loads that file only; it does not load `CLAUDE.md`. |
| Claude Code user | `~/.claude/CLAUDE.md` |
| omp user | One provider-selected user context; the project bootstrap does not rely on `~/.claude/CLAUDE.md` |

The root `AGENTS.md` is tracked and available in a fresh clone.
The root `CLAUDE.local.md` is tracked by `local/context-file-workflow` and any ref that carries this commit; it carries only the Claude Code bootstrap path.
The root `CLAUDE.md` is ignored and may be absent there.
The tracked `AGENTS.md` carries the same bootstrap path for omp sessions.

`stack setup` closes it for a checkout, and `stack new` runs it for every worktree it creates:

- `CLAUDE.local.md` → tracked bootstrap, present in checkouts of a ref that contains it
- `CLAUDE.md` → the checkout's real file; linked worktrees get a symlink to the main checkout's copy, for Claude Code and manual reads from omp
- `CLAUDE-history.md` → the history companion; linked worktrees get a symlink to the main checkout's copy
- `stack` → the checkout's script; linked worktrees get a symlink so the `./stack` habit works there too
- `~/.local/bin/stack` → the PATH entry, so `stack` works from anywhere, including a checkout that has none of this

`CLAUDE.md` is covered by upstream's `.gitignore`; `stack`, `stack.tsv`, and `CLAUDE-history.md` are in the shared `.git/info/exclude`.
The PATH symlink is outside the checkout, so a seeded worktree stays clean in `git status`.
The tracked bootstrap travels with the branch or ref that carries it. `local/context-file-workflow` is fork-only and never gets a PR.

`~/.claude/CLAUDE.md` is the Claude Code user file and contains machine-wide guidance only. OMP applies its own provider and shadowing rules for user context, so the project bootstrap does not rely on that file. The tracked `AGENTS.md` and `CLAUDE.local.md` carry the bootstrap paths for fresh sessions; this file carries the normal branch, stack, worktree, and PR rules.
A clone on another machine has no tooling at all — not even `stack`, so `stack setup` cannot be
the first command there. Git alone is enough to break the circle:

```bash
git fetch -q origin local/tooling && git show FETCH_HEAD:stack > stack && chmod +x stack && ./stack setup
```

`setup` then restores the untracked tooling from that never-merged branch: `stack.tsv`, `CLAUDE.md`,
`CLAUDE-history.md` and both hooks, written with `git show` so nothing is staged. It does not restore
`CLAUDE.local.md`; that bootstrap is tracked in the branch itself. Setup seeds the exclude lines a clone
never receives, and installs the PATH entry if no other clone owns it.
`stack setup --publish` creates or refreshes the branch from this checkout. It is never a ledger
row, so `stack daily` never merges it.

## Developing with hot reload

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

## Surviving reboots

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

## Auditing it — `./stack audit`

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
