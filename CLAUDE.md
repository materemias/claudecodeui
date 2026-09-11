# claudecodeui — personal fork workflow

Gitignored, local only. Repo-wide engineering rules are in the tracked `AGENTS.md`.
Identify this fork with `git remote -v`: upstream is `siteboon/claudecodeui`; the fork is `materemias/claudecodeui` on `origin`.

Everything here is operational. Claude Code injects this file into each session, and the tracked `AGENTS.md` points omp sessions here before editing. History and
rarely-needed recipes — restacking, backup refs, why the stack looks like this — are in
`CLAUDE-history.md` beside it, read on demand.

## Project-wide change and PR discipline

These rules apply to every feature, fix, refactor, and upstream PR.

- **One purpose per PR.** State the intended behavior change and what must stay unchanged
  before editing. Every changed hunk must serve that purpose; incidental cleanup and unrelated
  fixes belong elsewhere.
- **Preserve existing setups outside the agreed scope.** A new provider or optional capability
  must not change another provider's behavior, defaults, configuration, or workflows.
  Intentional changes to existing behavior require explicit scope and disclosure.
- **Use existing extension points before changing shared mechanisms.** Necessary additions
  through an existing extension point are not shared refactors merely because they edit a
  shared file. Changes to shared mechanisms or existing-provider behavior need a separately
  scoped PR with their own rationale and verification. Follow any stricter feature-specific
  frontend or transport restrictions below.
- **Critically reassess ports.** Existing branch architecture and dependencies are source
  material, not requirements. Inspect current upstream extension points and comparable
  providers before proposing shared changes. Do not present a dependency of the old solution
  as an unavoidable requirement of the new feature.
- **Evidence before a PR-rule exception.** Before asking to change agreed scope, provide
  exact upstream files/symbols, the existing patterns tried, a runnable reproduction of
  the missing required behavior, and why provider-private adaptation cannot solve it.
  Identify the smallest proposed exception and its preservation checks. Passing tests or
  a separate PR do not authorize it. Bring the evidence to the user first and obtain explicit
  scope approval before implementation or publication. Respect a maintainer's rejection
  until that decision is explicitly changed; do not repackage rejected work as a prerequisite.
- **Own the recommendation.** Do not blame or pressure the user to negotiate speculative
  exceptions. State the technical evidence and uncertainty, and prefer a compliant design.
- **Reviewability is scope clarity, not merely line count.** Prefer a larger cohesive change
  over a smaller diff that mixes concerns. AI-generated code has the same ownership and review
  obligations as handwritten code; generating more functionality does not authorize more scope.
- **Judge the submitted diff, not the branch name.** Before pushing, inspect every changed file
  and commit against the actual upstream PR base. Inherited parent commits count toward scope.
  Local stacking and a green `my/daily` build do not make a mixed-scope PR acceptable.
- **Verify both the addition and the preservation contract.** Exercise the intended behavior
  and the affected existing paths that must remain unchanged. Describe only behavior the posted
  code implements and checks actually performed; distinguish historical results from current-head
  verification. Passing tests do not excuse an out-of-scope change.

## OMP delivery: preservation and initial PR scope

The maintainer's primary requirement is to add OMP without changing existing providers'
behavior, defaults, configuration, or workflows. Necessary OMP additions through existing
extension points are appropriate; a larger cohesive PR is acceptable. This is not permission
to bundle unrelated cleanup or redesign shared mechanisms.

**Released OMP only.** The core integration must work with the latest installed OMP release
available at implementation and verification time. Use its public ACP behavior and native files
as-is. Never patch, fork, or modify OMP, and never require a custom OMP extension, plugin, rule,
skill, or injected marker to make the integration function.

The maintainer also explicitly restricts the **initial OMP-addition PR**:

- **Add OMP through existing provider contracts.** OMP-private backend implementation and
  necessary identity, type-export and registration entries belong here. Adding `omp` to
  `LLMProvider`, exporting existing contracts through their barrel, and adding completed
  provider entries to registries, allowlists or capability maps are normal extension-point
  work. Preserve existing providers' behavior; do not redesign shared mechanisms.
  Identity/type availability does not imply functional registration. An intermediate unit
  may defer the registry instance until all required provider adapters work, without stubs.
- **OMP shared-import exception.** The user approved following the existing OpenCode
  auth/model implementations: import existing contracts/types/helpers directly from
  `@/shared/interfaces.js`, `@/shared/types.js` and `@/shared/utils.js` rather than expanding
  `server/shared/index.ts`. This scoped exception overrides the shared-barrel rule for these
  OMP provider imports. Keep a comment at each exception citing the OpenCode precedent.
  Do not generalize it into a cross-module import policy or change other providers.
- **Registration must remove the temporary partial maps.** In the same commit that registers
  the real OMP provider, restore exhaustive `Record<LLMProvider, ...>` types in
  `provider.registry.ts`, `services/provider-capabilities.service.ts` and both the result
  type and local counts in `services/session-synchronizer.service.ts`. Add the real OMP
  entries and restore `getProviderCapabilities(): ProviderCapabilities` without `undefined`.
  Registration and the provider PR are incomplete while these temporary `Partial` types
  remain. Do not preserve them through casts, `Exclude` aliases or a new registered-provider
  type just for intermediate commits. Verify every registered provider has capabilities
  and a synchronization count, plus typecheck and preservation tests, before declaring
  registration complete.
- **Keep frontend functionality separate.** The stated exception is adding the OMP provider
  name to provider lists. Setup flows, provider visuals, state handling and chat rendering
  are not automatically covered by that exception, even when OMP-only and nonconflicting.
  They are legitimate separate PR scopes, not inherently harmful changes.
- **Keep all frontend and backend WebSocket changes separate.** The initial PR must leave
  transport, protocol, connection lifecycle, subscriptions and event handling unchanged.
- **Preserve shared mechanisms and other providers' implementations.** A separate PR does
  not by itself authorize a shared change. Apply the evidence-and-approval gate above,
  including to prerequisites and later enhancements. Explicit maintainer rejections bind
  the delivery plan, not only the first PR.
- **Apply both tests: purpose and explicit scope.** "Necessary for OMP and does not affect
  other providers" satisfies the preservation goal, but does not override the explicit
  frontend/WebSocket exclusions. If the maintainer explicitly broadens that scope, record
  the agreement and update this section before combining those changes.

These restrictions govern the initial provider PR, not the entire OMP effort. Additional
capabilities may be proposed in separately scoped PRs; a proposal is not authorization to
open, merge or deploy one. These rules override historical branch-stack examples below.

The maintainer explicitly rejected the proposed `feat/omp/mcp-capabilities` and
`feat/omp/model-storage` prerequisites. Do not implement or submit them. Follow OpenCode's
existing optional/unsupported MCP contract and model catalog/selection path. Selectable
models do not imply custom-model persistence in `provider_models`. Do not change shared
MCP interfaces/global behavior or the model table's constraint/migrations for this port.

### Replacement effort and local-stack isolation

Before planning or implementing any `feat/omp/*` replacement work, read `docs/omp.md` for
the extraction plan and `docs/omp-worklog.md` for completed work and the next action. Both are
local-only and excluded through `.git/info/exclude`; do not commit them or modify
`.gitignore` for them. In rewrite worktrees, symlink these files and this guidance to
the main checkout so there is one local source of truth. Verify local exclusion before work.

For every OMP rewrite task, load and apply the `ponytail` skill before designing, editing,
or reviewing code. Require the same of delegated agents. Prefer existing contracts and
the smallest correct implementation; preserve all required behavior and safety checks.
Update the worklog after each completed unit with exact source/target heads, changes,
checks actually run, and remaining work. Planned or inventoried behavior is not verified
replacement parity.

Prepare the replacement in dedicated `feat/omp/*` worktrees with isolated runtime data.
Worktrees share refs, remotes and configuration: change only the new rewrite branches.
Do not register them in the active `stack.tsv`, use
the active `stack new` for them, rewrite original feature branches, rebuild `my/daily`,
or restart production for this effort. The original stack stays intact until the full
replacement passes every parity gate and the user explicitly authorizes cutover.

### OMP continuity and delivery priority

Develop the normal provider workflow before rare recovery hardening. The completed
`feat/omp/session-identity` change is parked for a later PR, not an automatic prerequisite.
Implement against released OMP ACP and native-file contracts only.

Synchronization of state changes initiated through OMP TUI `/tree`, `/branch`, `/fork`, and
`/resume` is a known unsupported gap. Do not infer their active session or head from mtime,
titles, newest entries, descendant order, or ambiguous terminal breadcrumbs. Do not modify OMP
or require custom extensions to close the gap. Provider-managed ACP lifecycle operations and
the app's existing independent-fork contract remain in scope; never describe them as native
TUI slash-command synchronization. Frontend and WebSocket integration still belong in their
separately scoped PRs. See `docs/omp.md` for the provider-first PR order.

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

Which harness reads which project file, what the tracked `AGENTS.md` and `CLAUDE.local.md`
bootstraps carry, and how `stack setup` seeds a checkout or a fresh clone: all in
`CLAUDE-history.md` under this same heading. Read it when seeding a checkout, or when a session
did not pick this file up.

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

### Developing with hot reload, and surviving reboots

`./stack dev <branch>` runs vite on `:5173` against a `tsx watch` backend on `:3112`, inside that
branch's worktree, and never touches pm2. Use `http://localhost:5173`, not `127.0.0.1:5173`.
Ports: `3111` daily (pm2, built), `3112` dev backend, `5173` vite.

pm2 brings the fork back at boot through `pm2-remias.service`. **Run pm2 as `remias`, never with
`sudo`**: a root pm2 writes to a dump the boot unit never reads, so it looks fine and restores
the old list. **`pm2 save` after any change to which apps run.**

Both in full in `CLAUDE-history.md`: the dev-pair flags including `--fresh`, and the reboot proof
sequence with the `Type=forking` trap.

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

`./stack audit` replays every rebuild merge with rerere off and `merge.conflictStyle=diff3`, in a
throwaway worktree, and classifies each conflict. Read-only, and it exits non-zero only on a
ledger `base` column that names a ref the branch never sat on, never on a shared-name hint. The
conflict-class table and the cache-hygiene notes are in `CLAUDE-history.md`.

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
single subject; `./stack ls` prints the current shape.

The letters this file uses, here and in the rebuild section above: **A** `feat/shared-tool-approval-registry`, **B** `feat/omp-provider` on A, **C** `feat/omp-rich-history` and **E** `feat/running-sessions-linux`, both on B.

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
