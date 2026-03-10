## Meiotic Report: Craftsperson -- Skills Picker UX Polish

### Summary
The `$` skills picker shows a dead-end "No skills found" message whenever the Codex app-server has no active session, because `codexAppServerManager.listSkills()` returns `[]` when `this.sessions` is empty -- but the UI gives no hint about *why* skills are absent or *what the user should do*, creating a confusing "broken" feeling in the most common cold-start scenario.

### Key Findings

| # | Finding | Evidence | Confidence | Crossover Potential |
|---|---------|----------|------------|---------------------|
| 1 | **Root cause is server-side, not UI-side.** `codexAppServerManager.listSkills()` silently returns `[]` when no session exists. The RPC endpoint at `wsServer.ts:880-883` passes this through without any "no session" signal. The client cannot distinguish "no skills exist" from "cannot list skills right now." | `apps/server/src/codexAppServerManager.ts:879-884` -- the `if (!context) return []` guard | High | Architecture perspective: the API should return a typed "unavailable" state, not an empty list |
| 2 | **The empty message is a ternary dead-end.** `ComposerCommandMenu` at line 578-589 renders "No skills found." as a flat string when `items.length === 0 && !isLoading`. There is no differentiation between "searched and found nothing" vs "cannot search." | `apps/web/src/components/ChatView.tsx:578-589` | High | Content/copy perspective: "No skills found" implies the feature is working but empty |
| 3 | **The `@` file picker avoids this problem by requiring a query.** `projectSearchEntriesQueryOptions` has `enabled: ... && input.query.length > 0`, meaning the popover never fires for `@` alone with no query typed, while skills fires immediately on `$` with no query. The path picker never shows an embarrassing zero-results state on trigger. | `apps/web/src/lib/projectReactQuery.ts:39` vs `apps/web/src/lib/skillsReactQuery.ts:26` | High | Consistency: the two pickers have different trigger semantics |
| 4 | **`placeholderData` keeps stale skills alive but only within one mount.** `skillsListQueryOptions` uses `placeholderData: (previous) => previous ?? EMPTY_SKILLS_RESULT` with a 30s stale time. If the session ends and the user types `$`, the query fires, the server returns `[]`, and the stale data is replaced. There is no persistent cache surviving session disconnect. | `apps/web/src/lib/skillsReactQuery.ts:27-28` | High | Data layer: `gcTime` is not configured, so TanStack Query's default 5-minute GC could preserve skills briefly |
| 5 | **CodexMonitor avoids the problem entirely** by gating skill fetching behind `isConnected`. Their `useSkills` hook early-returns when `!isConnected`, keeping whatever skills were previously loaded. Their autocomplete simply shows nothing when the `skills` array is empty -- the popover hides because `active: state.active && matches.length > 0`. | CodexMonitor `src/features/skills/hooks/useSkills.ts` lines 21-23 and `useComposerAutocomplete.ts` return value | High | Pattern precedent from the reference app |
| 6 | **The composer placeholder text already knows about `$skills`.** The placeholder reads `"Ask anything, @tag files/folders, $skills, or use /model"` at line 3743, advertising the feature even when it cannot work. | `apps/web/src/components/ChatView.tsx:3743` | Medium | Marketing a broken feature erodes trust |
| 7 | **No error state is ever surfaced.** `skillsQuery.error` and `skillsQuery.isError` are never referenced anywhere in the codebase. If the RPC fails, the user sees "No skills found" with no retry affordance. | Grep for `skillsQuery.error` -- zero results | High | Resilience perspective |
| 8 | **Session phase is readily available but unused by the skills flow.** `derivePhase()` returns `"disconnected" | "connecting" | "running" | "ready"` and is already computed at line 882. The skills query could trivially condition its message on phase. | `apps/web/src/session-logic.ts:616-621`, `ChatView.tsx:882` | High | The fix is low-cost |

### UX Recommendations (Ranked by Impact)

**State 1: App just opened / no session yet (phase === "disconnected")**

Current: Typing `$` shows popover with "Loading skills..." then "No skills found."
Proposed: Show a contextual hint instead:
```
"Skills load when a session is active. Send a message to start one."
```
This is the single highest-impact change. It turns confusion into guidance. The popover should still appear (dismissing it entirely would feel like `$` is broken), but the content should explain the state. Use a muted icon (e.g., `InfoIcon`) alongside the text to visually distinguish this from an error.

**State 2: Session starting (phase === "connecting")**

Current: Same "No skills found."
Proposed: Show `"Loading skills..."` with the existing loading state. The `isComposerMenuLoading` flag should treat `phase === "connecting"` as a loading indicator even before the query fires. This is a 1-line change:
```ts
// ChatView.tsx line 3373-3378
const isComposerMenuLoading =
  (composerTriggerKind === "path" && ...) ||
  (composerTriggerKind === "skill" &&
    (skillsQuery.isLoading || skillsQuery.isFetching || phase === "connecting"));
```

**State 3: Session active (phase === "ready" or "running")**

Current behavior works. No changes needed. The 30s stale time is reasonable.

**State 4: Session ended / disconnected after having been active**

Current: Skills disappear immediately on next `$` trigger.
Proposed: Two changes:
1. Set `enabled: false` on `skillsListQueryOptions` when `phase === "disconnected"` so the query does not fire and replace cached data with `[]`.
2. If cached skills exist from a previous session, show them with a subtle "(from previous session)" badge or slightly dimmed styling. The user can still reference them -- the skills themselves (`.claude/skills/` SKILL.md files) are filesystem-resident and do not depend on the session.
3. If no cached skills exist, show the State 1 hint.

**Micro-interactions for seamless transitions:**

- **Animate the popover content change.** When transitioning from "hint" state to "loaded skills" (user sends first message, session connects, skills load), fade-in the skill items rather than hard-swapping. CSS `transition-opacity` on the `CommandList` children is sufficient.
- **Pre-fetch on session connect.** Add an effect that eagerly calls `skillsQuery.refetch()` when phase transitions from `"connecting"` to `"ready"`, so skills are warm before the user types `$`. Currently skills only fetch lazily when `isSkillTrigger` is true.
- **Preserve keyboard flow.** If the popover is showing a hint (no items), pressing Enter or Tab should NOT insert anything -- it should just dismiss the popover. Currently `composerMenuItems` would be empty so `activeComposerMenuItem` is null, which seems safe, but this should be explicitly tested.

### Concrete Code Changes

**Change 1: Thread phase into ComposerCommandMenu**

```diff
// ChatView.tsx ComposerCommandMenu props
+ sessionPhase: SessionPhase | null;
```

**Change 2: Differentiated empty state messages**

Replace the ternary at lines 578-589 with:
```tsx
{props.items.length === 0 && (
  <p className="px-3 py-2 text-muted-foreground/70 text-xs">
    {props.isLoading
      ? props.triggerKind === "skill"
        ? "Loading skills..."
        : "Searching workspace files..."
      : props.triggerKind === "skill"
        ? props.sessionPhase === "disconnected" || props.sessionPhase === null
          ? "Skills load when a session starts. Send a message to begin."
          : "No skills found."
        : props.triggerKind === "path"
          ? "No matching files or folders."
          : "No matching command."}
  </p>
)}
```

**Change 3: Guard skills query against disconnected state**

```diff
// ChatView.tsx line 1216-1221
  const skillsQuery = useQuery(
    skillsListQueryOptions({
      cwd: gitCwd,
-     enabled: isSkillTrigger,
+     enabled: isSkillTrigger && phase !== "disconnected",
    }),
  );
```

This single line prevents the query from firing when there is no session, preserving any cached data from a previous session.

**Change 4: Eager prefetch on session connect**

```tsx
// New effect in ChatView around line 890
useEffect(() => {
  if (phase === "ready" && gitCwd) {
    queryClient.prefetchQuery(skillsListQueryOptions({ cwd: gitCwd }));
  }
}, [phase, gitCwd, queryClient]);
```

### Blind Spots

Things this perspective CANNOT see (important for synthesis):

- **Server-side API design**: Whether the skills RPC should return a typed `{ status: "unavailable" | "ok", skills: [] }` envelope rather than always returning `{ skills: [] }`. This is an architecture decision, not a UX one.
- **Performance cost of prefetching**: Whether eagerly calling `skills/list` on every session connect adds meaningful latency or load. The codex app-server's `skills/list` RPC cost is unknown from this perspective.
- **Multi-provider future**: If Claude Code (mentioned as "coming soon") has its own skill system, the "no session" UX might need to be provider-aware. This lens cannot evaluate that.
- **Accessibility**: Screen reader behavior for the dynamic hint text vs error text distinction has not been evaluated.
- **Testing**: Whether the existing test suite covers the composer menu's empty states at all.

### Crossover Points

Connections to other possible perspectives:

- **Architecture**: The fundamental issue is that the server API returns an indistinguishable empty array for "no session" vs "no skills." An architect would likely propose a discriminated union response type in `packages/contracts/src/skill.ts`. This would make ALL the UI fixes cleaner.
- **Data/Caching**: The `placeholderData` strategy in `skillsReactQuery.ts` is reasonable but could be strengthened with explicit `gcTime: Infinity` to keep skills cached across session lifecycle. A data perspective would evaluate cache invalidation strategy.
- **Content/Copy**: The exact wording of hint messages ("Skills load when a session starts") is a content decision. A content perspective might prefer different language or suggest adding a link/shortcut to start a session.
- **Testing**: The `composer-logic.test.ts` file tests trigger detection but does not test the rendering of empty states. A testing perspective would identify this gap.

### Methodology

- Files examined:
  - `apps/web/src/components/ChatView.tsx` (lines 267, 410-594, 770-900, 1190-1320, 3360-3410, 3470-3510, 3630-3760)
  - `apps/web/src/lib/skillsReactQuery.ts` (full file, 31 lines)
  - `apps/web/src/lib/projectReactQuery.ts` (full file, 44 lines)
  - `apps/web/src/composer-logic.ts` (full file, 195 lines)
  - `apps/web/src/session-logic.ts` (lines 610-622)
  - `apps/web/src/nativeApi.ts` (full file)
  - `apps/server/src/codexAppServerManager.ts` (lines 870-930)
  - `apps/server/src/provider/Layers/ProviderService.ts` (lines 470-500)
  - `apps/server/src/provider/Layers/CodexAdapter.ts` (lines 1488-1522)
  - `apps/server/src/wsServer.ts` (lines 870-910)
  - `packages/contracts/src/skill.ts` (full file, 31 lines)
  - `packages/contracts/src/ipc.ts` (lines 144-155)
  - `apps/web/src/components/PlanSidebar.tsx` (lines 240-268)
  - CodexMonitor reference: `src/features/skills/hooks/useSkills.ts`, `src/features/composer/hooks/useComposerAutocomplete.ts`, `src/features/composer/hooks/useComposerAutocompleteState.ts`, `src/features/composer/components/ComposerInput.tsx`, `src/features/app/hooks/useMainAppComposerWorkspaceState.ts`
- Searches performed:
  - "No skills found" across codebase (1 hit)
  - `skillsQuery.error` / `skillsQuery.isError` (0 hits -- confirming no error handling)
  - Loading/empty/skeleton patterns across `apps/web/src` (surveyed consistency)
  - `derivePhase` usage (confirmed available in ChatView scope)
  - `listSkills` across server codebase (traced full call chain)
  - CodexMonitor GitHub repo tree + 5 file fetches via API
- Dead ends:
  - GitHub code search for CodexMonitor skills (requires auth, used API tree listing instead)
  - `composer-logic.ts` initially reported as not found at `apps/web/src/lib/` (actual path is `apps/web/src/composer-logic.ts`)
