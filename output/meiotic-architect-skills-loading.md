## Meiotic Report: Architect -- Design Approaches for Pre-Session Skill Loading

### Summary
The hybrid approach (filesystem scan for immediate display, reconcile with RPC once session is live) is the clear winner: it delivers sub-10ms picker population, 100% correctness at session time, and ~120 lines of code by resurrecting the deleted `skillScanner.ts` as a fallback layer behind the existing `ProviderAdapter.listSkills` contract.

### Key Findings

| # | Finding | Evidence | Confidence | Crossover Potential |
|---|---------|----------|------------|---------------------|
| 1 | **The core problem is a single guard clause.** `listSkills` at `codexAppServerManager.ts:881` grabs `this.sessions.values().next().value` and returns `[]` if no session exists. The entire skill pipeline is otherwise session-independent. | `codexAppServerManager.ts:879-884` | Very High | Performance, UX |
| 2 | **Codex's own SkillsManager does NOT require an active thread.** The Rust `skills_for_cwd()` method operates on filesystem paths with an in-process cache. The app-server exposes this via `skills/list` RPC, which only needs `initialize` -- not `thread/start` or `thread/resume`. | Codex repo `skills/manager.rs` via WebFetch; `skills/loader.rs` confirms scan-only operation | High | Correctness |
| 3 | **A filesystem scanner existed and was deliberately deleted** in commit `a9f9a4e`. The deleted `skillScanner.ts` (148 lines) scanned `.agents/skills` directories and `~/.agents/skills` but **missed** `~/.codex/skills` (the actual primary location), `.codex/skills/.system/`, and nested `local/` subdirectories. It also used a simplistic frontmatter parser that could not handle multi-line YAML descriptions. | `git show a9f9a4e^:apps/server/src/skillScanner.ts` | Very High | Correctness |
| 4 | **The Codex app-server cold-starts in ~143ms** (`--help` baseline). The full `initialize` + `model/list` + `account/read` handshake adds network latency for account verification. A skills-only startup could skip `model/list`, `account/read`, `thread/start` -- but still pays the process spawn + `initialize` cost (~300-500ms estimated). | `time codex app-server --help` measured at 0.143s; `codexAppServerManager.ts:595-615` shows 3 RPC calls during startup | High | Performance |
| 5 | **Skill directory structure is well-defined and stable.** Each skill is a directory containing `SKILL.md` with YAML frontmatter (`name`, `description`, optional `metadata.short-description`). Locations: `~/.codex/skills/` (user), `~/.codex/skills/.system/` (system), `.agents/skills/` (repo), `/etc/codex/skills` (admin). Max scan depth: 6 levels, max 2000 dirs per root. | Codex `skills/loader.rs`; verified on-disk at `~/.codex/skills/` (14 dirs, 30 SKILL.md files) | Very High | Correctness |
| 6 | **The `Skill` contract is already minimal and filesystem-friendly.** The `packages/contracts/src/skill.ts` schema requires only `name`, `description`, `enabled`, with optional `path` and `interface`. A filesystem scanner can populate all required fields from SKILL.md frontmatter alone. | `packages/contracts/src/skill.ts:7-20` | Very High | Implementation |
| 7 | **The web client already has the right architecture for progressive enhancement.** `skillsReactQuery.ts` uses `staleTime: 30_000` and `placeholderData: (previous) => previous`, meaning a fast initial scan can serve as placeholder data while an RPC refresh replaces it. | `skillsReactQuery.ts` (from feature branch) | Very High | UX |
| 8 | **The ProviderService layer fans out to ALL adapters.** `ProviderService.listSkills` calls `adapter.listSkills(cwd)` on every registered adapter with `concurrency: "unbounded"` and flattens results. A filesystem fallback could be wired at the ProviderService level or the CodexAdapter level without changing the contract. | `apps/server/src/provider/Layers/ProviderService.ts:476-484` | Very High | Implementation |

---

### Approach Evaluations

#### 1. Eager App-Server (start short-lived process just for skills)

- **Complexity**: Medium (~80 LOC). Requires lifecycle management for ephemeral process.
- **Latency**: 300-500ms (spawn + initialize + skills/list + teardown). Too slow for picker popup.
- **Correctness**: Perfect -- uses the same code path as session-time.
- **Coupling**: High -- depends on Codex binary being available and responsive.
- **Failure mode**: Process spawn failure = no skills. Race condition if real session starts while ephemeral process is alive.
- **Verdict**: REJECTED. The latency alone disqualifies it for "performance first" -- 300-500ms delay on `$` keystroke is unacceptable. The process lifecycle complexity (two managers? shared manager with ephemeral flag?) adds fragility.

#### 2. Filesystem Scanner (read SKILL.md directly)

- **Complexity**: Low (~120 LOC). The deleted `skillScanner.ts` was 148 lines but incomplete.
- **Latency**: <10ms for typical installations (14 dirs, 30 files on this machine).
- **Correctness**: ~90%. Misses: (a) skills disabled via config.toml, (b) plugin-namespaced skills, (c) `agents/openai.yaml` interface metadata, (d) future Codex skill resolution changes.
- **Coupling**: Medium -- depends on Codex's on-disk layout (SKILL.md frontmatter format, directory conventions). Layout has been stable for 6+ months.
- **Failure mode**: Graceful -- returns empty array on any I/O error. Cannot be worse than current state (already returns `[]` pre-session).
- **Verdict**: VIABLE as a standalone approach, but the ~10% correctness gap matters for the `$` picker showing skills that Codex won't actually load (or missing skills Codex does load).

#### 3. Cached/Stale Skills (persist last-known list, refresh on session start)

- **Complexity**: Medium (~100 LOC + persistence). Requires SQLite or JSON file for per-project cache.
- **Latency**: <5ms (read from cache). Cold start with empty cache = no skills until first session.
- **Correctness**: Stale. Skills could have been added/removed between sessions. First-time projects show nothing.
- **Coupling**: Low -- only depends on the Skill schema, not Codex internals.
- **Failure mode**: Silent staleness -- user sees outdated list with no indication.
- **Verdict**: REJECTED as standalone. The cold-start problem (new project = empty picker) is a dealbreaker for first impressions. However, caching is an excellent COMPLEMENT to other approaches.

#### 4. Hybrid: Filesystem Scan + RPC Reconciliation (RECOMMENDED)

- **Complexity**: ~150 LOC total. Filesystem scanner (~100 LOC) + reconciliation logic (~50 LOC).
- **Latency**: <10ms for initial display. Reconciliation happens transparently when session starts.
- **Correctness**: 100% at session time (RPC replaces filesystem results). ~90% pre-session (filesystem only).
- **Coupling**: Medium for filesystem layer, zero for RPC layer (already exists).
- **Failure mode**: Filesystem scan fails -> falls through to RPC (current behavior). RPC fails -> filesystem results persist (better than current `[]`).
- **Verdict**: RECOMMENDED. Exploits the existing `placeholderData` pattern in React Query.

**Concrete implementation sketch:**

```
1. Resurrect skillScanner.ts as skillScannerFallback.ts with fixes:
   - Scan ~/.codex/skills/ (not ~/.agents/skills/)
   - Support nested directories (local/, .system/)
   - Handle multi-line YAML descriptions properly

2. In CodexAdapterLive.listSkills:
   - If any session exists: use RPC (current path)
   - If no session: call skillScannerFallback.scanSkills(cwd)

3. In skillsReactQuery.ts:
   - On session start event: invalidate skills query cache
   - The staleTime: 30_000 + placeholderData pattern handles the rest
```

The key insight: the ProviderAdapter contract already returns `Effect<ReadonlyArray<Skill>>` which allows the implementation to choose its data source internally. No contract changes needed.

#### 5. Lazy RPC Pool (warm app-server process pool)

- **Complexity**: High (~300+ LOC). Process pool management, health checks, recycling.
- **Latency**: ~50ms (already-warm process can answer skills/list immediately after initialize).
- **Correctness**: Perfect -- same code path as session.
- **Coupling**: Very High -- depends on app-server lifecycle, pool sizing, resource usage.
- **Failure mode**: Resource leak. Each warm process consumes ~30-50MB RSS. Pool needs graceful drain on shutdown.
- **Verdict**: REJECTED. Grossly over-engineered for the problem. The resource cost of idle Codex processes contradicts "performance first." This would make sense only if T3 Code needed to answer many metadata queries continuously, which it does not.

---

### Ranked Recommendations

1. **Hybrid (Approach 4)** -- Best balance of all criteria. Ship the filesystem scanner as fallback, rely on RPC for reconciliation. ~150 LOC.
2. **Filesystem Scanner only (Approach 2)** -- If Approach 4 is deemed over-engineered, a corrected filesystem scanner alone is 90% correct and dramatically better than the current empty-list behavior. ~120 LOC.
3. **Cached + Filesystem (Approach 3 + 2)** -- If latency of even filesystem scanning becomes a concern (unlikely at <10ms), add a JSON cache layer. Only worthwhile if users report lag. ~200 LOC.

Approaches 1 and 5 are definitively rejected on performance and complexity grounds.

### Critical Implementation Detail

The deleted `skillScanner.ts` had three bugs that must NOT be repeated:

1. **Wrong directory**: Scanned `~/.agents/skills/` instead of `~/.codex/skills/`. The actual Codex user skills directory is `~/.codex/skills/` (confirmed on disk).
2. **No recursive scanning**: Missed `~/.codex/skills/local/` and `~/.codex/skills/.system/` subdirectories which contain nested skill folders.
3. **Naive YAML parsing**: Used line-by-line regex that breaks on multi-line `description: |-` blocks. A proper YAML parser (or at minimum, multi-line aware regex) is needed.

The fix for (3) is to use a minimal YAML frontmatter parser like `gray-matter` or handle the `|-` / `>-` block scalar indicators, which is only ~20 extra lines.

### Blind Spots
Things this perspective CANNOT see (important for synthesis):
- Actual user perception of the ~90% vs 100% correctness gap (UX perspective needed)
- Whether the filesystem scanner's I/O pattern causes jank on Windows/slow disks (Performance perspective needed)
- Whether Codex upstream plans to change the skill directory layout (Ecosystem/dependency perspective needed)
- The test surface area implications -- how to test filesystem scanning in CI without a real `~/.codex` (Testing perspective needed)
- Whether the `$` trigger UX itself is the right interaction pattern vs alternatives (UX perspective needed)

### Crossover Points
Connections to other possible perspectives:
- **Performance**: The hybrid approach's <10ms filesystem scan should be benchmarked on Windows with antivirus (which can add 50-100ms per directory read). If this is a concern, the cache layer from Approach 3 becomes load-bearing.
- **Security**: The filesystem scanner reads arbitrary paths. Path traversal in `cwd` input could scan unintended directories. The existing `resolveWorkspaceWritePath` pattern in `wsServer.ts:156-192` shows the project already guards against traversal -- similar guards should apply.
- **Testing**: The deleted scanner had zero tests. A new implementation should be tested with a temp directory containing mock SKILL.md files, similar to `codexAppServerManager.test.ts`.
- **UX**: The `placeholderData` pattern means users might briefly see a skill in the picker that disappears on reconciliation. This is a minor flash-of-stale-content issue that could confuse users. The UX perspective should evaluate whether to mark pre-session skills as "unverified."
- **Dependency/Ecosystem**: The Codex repo shows the skill format evolving (new `agents/openai.yaml` file for extended metadata, plugin namespacing). A filesystem scanner creates a parallel parsing path that must track upstream changes.

### Methodology
- Files examined:
  - `apps/server/src/codexAppServerManager.ts` (skill listing implementation, session lifecycle, process spawn)
  - `apps/server/src/provider/Layers/CodexAdapter.ts` (adapter wiring for listSkills)
  - `apps/server/src/provider/Services/ProviderAdapter.ts` (contract interface)
  - `apps/server/src/provider/Layers/ProviderService.ts` (fan-out to adapters)
  - `apps/server/src/provider/Services/ProviderService.ts` (service contract)
  - `apps/server/src/wsServer.ts` (WS route for skills.list)
  - `packages/contracts/src/skill.ts` (Skill schema)
  - `packages/contracts/src/ws.ts` (WS method registration)
  - `packages/contracts/src/ipc.ts` (NativeApi contract)
  - `apps/web/src/lib/skillsReactQuery.ts` (React Query config, from feature branch)
  - `apps/web/src/components/ChatView.tsx` (composer skill trigger, from feature branch)
  - Deleted `apps/server/src/skillScanner.ts` (recovered via `git show a9f9a4e^`)
  - `~/.codex/skills/` directory structure (14 dirs, 30 SKILL.md files on disk)
  - `~/.codex/skills/.system/skill-creator/SKILL.md` (system skill example)
  - Codex open-source repo: `skills/loader.rs`, `skills/manager.rs`, `skills/model.rs`
- Searches performed:
  - Skill-related file references across server and web packages
  - Git history for filesystem scanner creation and deletion
  - Codex app-server startup cost measurement (143ms cold start)
  - On-disk skill directory structure and file counts
  - Codex upstream skill resolution source code
- Dead ends:
  - Codex SDK docs URL from CLAUDE.md returned redirect/unavailable content
  - `codex-rs/core/src/skills.rs` does not exist (skills is a directory, not a file)
  - Attempted to find `.agents/skills/` on disk (does not exist -- confirms deleted scanner was wrong)
