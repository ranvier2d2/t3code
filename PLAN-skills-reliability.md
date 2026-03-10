# Plan: Skills Reliability Fixes

## Context

Post-merge follow-up for pre-existing reliability issues in `codexAppServerManager.ts`
surfaced during CodeRabbit review of PR #2. These are all in the skills subsystem
and existed before the `skillSelections` pipeline was added.

## Fix 1: Defer codex binary/home assignment until after validation

**Problem**: `this.codexBinaryPath` and `this.codexHomePath` are assigned at lines
572-573, *before* the version check at line 574. A failed `startSession()` poisons
the instance state, causing subsequent `ensureSkillsHandle()` calls to use a bad
binary path.

**File**: `apps/server/src/codexAppServerManager.ts` (lines 569-578)

**Fix**: Use local variables through the validation and startup flow. Only assign
to `this.codexBinaryPath` / `this.codexHomePath` after `assertSupportedCodexCliVersion`
succeeds and the session subprocess is confirmed running.

```typescript
// Before (current):
this.codexBinaryPath = codexBinaryPath;
this.codexHomePath = codexHomePath;
this.assertSupportedCodexCliVersion({ ... });

// After:
this.assertSupportedCodexCliVersion({
  binaryPath: codexBinaryPath,
  cwd: resolvedCwd,
  ...(codexHomePath ? { homePath: codexHomePath } : {}),
});
// ... later, after session is confirmed good:
this.codexBinaryPath = codexBinaryPath;
this.codexHomePath = codexHomePath;
```

**Risk**: Low. The local variables are already used for the spawn call; we just
delay the instance assignment.

---

## Fix 2: Unify skills handle cleanup and fix pending request leaks

**Problem**: Three separate issues in `ensureSkillsHandle()` (lines 899-965):

1. **Exit/error handlers don't reject pending requests** (lines 939-948): They only
   null the handle, leaving `sendRequest()` calls hanging until timeout. Compare with
   `stopSkillsHandle()` (lines 968-981) which properly rejects all pending promises.

2. **Child process leak on init failure** (line 951): If `initialize` throws, the
   spawned child is never killed. The catch block (lines 959-964) clears the promise
   but doesn't clean up the process.

3. **Race between init and teardown**: `stopSkillsHandle()` can't see the child until
   line 954 assigns `this.skillsHandle`, so a shutdown during `initialize` leaks the
   process.

**File**: `apps/server/src/codexAppServerManager.ts` (lines 899-981)

**Fix**: Extract a shared `cleanupSkillsHandle(handle)` method and use it in all
three paths:

```typescript
private cleanupSkillsHandle(handle: JsonRpcProcessHandle): void {
  if (this.skillsHandle === handle) {
    this.skillsHandle = null;
  }
  this.skillsHandlePromise = null;
  for (const pending of handle.pending.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error("Skills handle stopped."));
  }
  handle.pending.clear();
  handle.output.close();
  killChildTree(handle.child);
}
```

Then:
- `child.on("exit")` and `child.on("error")` → call `cleanupSkillsHandle(handle)`
- `stopSkillsHandle()` → call `cleanupSkillsHandle(handle)`
- Wrap the `initialize` + assignment block in try/catch that calls
  `cleanupSkillsHandle(handle)` on failure
- Assign `this.skillsHandle = handle` *before* awaiting `initialize` so that
  `stopSkillsHandle()` can see it during init (the cleanup method is idempotent)

**Risk**: Medium. Touches process lifecycle; needs careful testing of:
- Normal skills load path
- Skills load when binary is missing/broken
- `stopAll()` during skills init
- Rapid `listSkills()` calls during init

---

## Fix 3: Route skills lookup through cwd-matching session

**Problem**: `fetchSkills()` (line 1010) picks `this.sessions.values().next().value`
— an arbitrary session. With multiple projects open, project B's `$` picker can
route through project A's process.

**File**: `apps/server/src/codexAppServerManager.ts` (line 1010)

**Fix**: Find a session whose `session.cwd` matches the requested `cwd`, falling
back to `ensureSkillsHandle(cwd)`:

```typescript
private async fetchSkills(cwd: string): Promise<CodexSkill[]> {
  // Prefer a session whose cwd matches; fall back to dedicated skills handle.
  let handle: JsonRpcProcessHandle | undefined;
  for (const ctx of this.sessions.values()) {
    if (ctx.session.cwd === cwd) {
      handle = ctx;
      break;
    }
  }
  handle ??= await this.ensureSkillsHandle(cwd);
  // ... rest unchanged
}
```

**Risk**: Low. The `skills/list` RPC already passes `cwds: [cwd]` so results are
correct regardless, but this avoids cross-process routing and is more predictable.

---

## Verification

1. `bun typecheck` must pass
2. `bun lint` must pass
3. `bun run test` — existing tests pass
4. Manual E2E:
   - Open two projects, type `$` in each → each shows its own skills
   - Kill codex binary mid-skills-load → no hung requests, re-query works
   - Start session with bad binary path, then fix path → skills still work

## Files Summary

| File | Fixes |
|------|-------|
| `apps/server/src/codexAppServerManager.ts` | All three fixes |
