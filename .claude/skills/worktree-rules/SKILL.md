---
name: worktree-rules
description: "Port changes from a git worktree to the main repository. This is the skill behind `/port-changes`; `worktree-rules` remains the underlying skill slug/directory. Use when asked to 'port changes', 'sync to main', 'push to main repo', '/port-changes', or when porting worktree commits."
---

# Worktree Rules (`/port-changes`) -- Worktree Porting Workflow

This skill's runtime slug/directory is `worktree-rules`. When a leader or worker is told to use `/port-changes`, this is the skill they should load.

The `/port-changes` command ports commits from the current worktree session to the main repository. Only use this in worktree sessions.

## Context

Every worktree session has these variables injected via system prompt:
- **Worktree branch**: the `-wt-N` branch you're working on
- **Base repo checkout**: the main repository path
- **Base branch**: the branch to sync to (usually the parent branch)

## Port Workflow

Follow this workflow **exactly** when asked to port, sync, or push commits:

### 1. Check the main repo

Pull remote changes first:
```bash
git -C <BASE_REPO> fetch origin <BASE_BRANCH> && git -C <BASE_REPO> pull --rebase origin <BASE_BRANCH>
```

Then run `git -C <BASE_REPO> status`. If there are uncommitted changes, **stop and tell the user** -- another agent may have work in progress. Never run `git reset --hard`, `git checkout .`, or `git clean` on the main repo without explicit user approval.

Read any new commits briefly to understand what changed since your branch diverged.

### 2. Rebase in the worktree

Rebase your worktree branch onto the main repo's local base branch. Since all worktrees share the same git object store, the base branch is directly visible as a ref -- no fetch needed:
```bash
git rebase <BASE_BRANCH>
```

Resolve all merge conflicts here in the worktree -- this is the safe place to do it.

### 3. Cherry-pick clean commits to main

Once the worktree branch is cleanly rebased with your new commits on top, cherry-pick only your new commits into the main repo:
```bash
git -C <BASE_REPO> cherry-pick <commit-hash>
```

Cherry-pick one at a time in chronological order.

Track the resulting **main-repo SHAs** in the same order as you cherry-pick them. These synced SHAs are the ones that matter for quest verification metadata. Do not reuse the worktree-only pre-port SHAs when the main repo now has different cherry-picked copies.

### 4. Handle unexpected conflicts

If cherry-pick still conflicts (it shouldn't after a clean rebase), tell the user the conflicting files and ask how to proceed. Do not force-resolve or abort without asking.

### 5. Verify and push

Run `git -C <BASE_REPO> log --oneline -5` to confirm the commits landed correctly, then push:
```bash
git -C <BASE_REPO> push origin <BASE_BRANCH>
```

### 6. Sync both worktree and local main branch

- Reset this worktree branch to match the base branch: `git reset --hard <BASE_BRANCH>`
- Fast-forward the local base branch in the main repo:
  ```bash
  git -C <BASE_REPO> checkout <BASE_BRANCH> && git -C <BASE_REPO> merge --ff-only origin/<BASE_BRANCH>
  ```

### 7. Run tests post-merge

After resetting, run the project's unit tests in the worktree to verify nothing broke. If tests fail:
- (a) If the fix is straightforward, fix it, commit, and re-sync following steps 1-6
- (b) Otherwise, explain the failures to the user and ask how to proceed

## Completion Checklist

Do NOT report the sync as complete until ALL of the following are true:
- [ ] Main repo log shows the cherry-picked commits
- [ ] Worktree has been reset to match the main repo branch
- [ ] Tests have been run **after the reset** AND passed (or failures reported to user)
- [ ] Changes have been pushed to the remote

## Quest Status Rule

If you are working on a quest from this worktree session, do **NOT** transition it to `needs_verification` until the sync workflow above is fully complete, the main repo contains the changes, and the branch has been pushed. If sync is still pending, leave the quest `in_progress`.

If you are also the agent performing the verification handoff, attach the ordered synced SHAs when you submit:
```bash
quest complete q-N --items "..." --commits "sha1,sha2"
```

If a leader controls the quest transition, report back with the ordered synced SHAs explicitly so the later handoff can attach them. Put them on a dedicated `Synced SHAs: sha1,sha2` line so the later `quest complete` call can copy them directly. Do **not** rely on `/port-changes` logs being parsed after the fact.

The quest should usually keep one substantive prose summary comment. Structured commit metadata should carry routine port information, so do not add a second long port-summary comment unless the porting itself was exceptional and materially worth calling out. The later verification handoff should attach those SHAs with `quest complete ... --commits ...`, not leave them only in feedback comments.
