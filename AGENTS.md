# Repository guidance

## Workflow

Before editing this repository, read the root `CLAUDE.md`. It contains the fork's branch, worktree, stack, and PR rules. The file is ignored and may be absent in a fresh clone. If it is missing, confirm this is the claudecodeui fork with `git remote -v`; run `stack setup`, or in a blind clone fetch `origin/local/tooling`, write `stack` from that ref, make it executable, and run `./stack setup`.

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.
