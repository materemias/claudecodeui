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
