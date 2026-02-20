<!-- WORKTREE_GUARDRAILS_START -->
# Worktree Session — Branch Guardrails

You are working on branch: `jiayi-wt-7085` (created from `jiayi`)
This is a git worktree. The main repository is at: `/home/jiayiwei/companion`

**Rules:**
1. DO NOT run `git checkout`, `git switch`, or any command that changes the current branch
2. All your work MUST stay on the `jiayi-wt-7085` branch
3. When committing, commit to `jiayi-wt-7085` only
4. If you need to reference code from another branch, use `git show other-branch:path/to/file`

## Porting Commits to the Main Repo

When asked to port/sync commits from this worktree to the main repository at `/home/jiayiwei/companion`, follow this workflow **exactly**:

1. **Check the main repo first.** Run `git -C /home/jiayiwei/companion status` and `git -C /home/jiayiwei/companion log --oneline -5`. If there are uncommitted changes, **stop and tell the user** — another agent may have work in progress. Never run `git reset --hard`, `git checkout .`, or `git clean` on the main repo without explicit user approval. Read any new commits briefly to understand what changed since your branch diverged.
2. **Rebase in the worktree.** Rebase your worktree branch onto the main repo's local branch. Since all worktrees share the same git object store, the main repo's local branch is directly visible as a ref — no fetch needed. Use `git rebase <main-repo-branch>` (the local branch name, not `origin/...`). Resolve all merge conflicts here in the worktree — this is the safe place to do it without affecting other agents.
3. **Cherry-pick clean commits to main.** Once the worktree branch is cleanly rebased with your new commits on top, cherry-pick only your new commits into the main repo using `git -C /home/jiayiwei/companion cherry-pick <commit-hash>`. Cherry-pick one at a time in chronological order.
4. **Handle unexpected conflicts.** If cherry-pick still conflicts (it shouldn't after a clean rebase), tell the user the conflicting files and ask how to proceed. Do not force-resolve or abort without asking.
5. **Verify after porting.** Run `git -C /home/jiayiwei/companion log --oneline -5` to confirm the commits landed correctly.
6. **Reset worktree to stay in sync.** After porting is complete, reset this worktree branch to match the main repo's branch: `git reset --hard <main-repo-branch>`. This keeps the worktree in sync and avoids divergence for future work.
7. **Run tests post-merge.** After resetting, run the project's unit tests in the worktree to verify nothing broke from merging with main. If tests fail: (a) if the fix is straightforward, fix it in the worktree, commit, and re-sync following steps 1–6 above; (b) otherwise, explain the failures to the user and ask how to proceed.
<!-- WORKTREE_GUARDRAILS_END -->