## Meiotic Report: Empiricist -- What the Code Actually Does vs. Assumed Constraints

### Summary
The assumption that `skills/list` requires an active Codex session is **empirically false**; a freshly spawned `codex app-server` process needs only `initialize` + `initialized` before responding to `skills/list` in under 900ms, and the upstream Codex test suite explicitly tests this sessionless path.

### Key Findings

| # | Finding | Evidence | Confidence | Crossover Potential |
|---|---------|----------|------------|---------------------|
| 1 | **The session dependency is self-imposed, not required by Codex.** The `listSkills` method in `CodexAppServerManager` grabs `this.sessions.values().next().value` (line 881) and returns `[]` if no session exists. But the Codex app-server `skills/list` RPC does NOT require a thread. The upstream test suite (`codex-rs/app-server/tests/suite/v2/skills_list.rs`) calls `skills/list` immediately after `initialize`, never calling `thread/start`. | `apps/server/src/codexAppServerManager.ts:879-883` -- the guard `if (!context) return []` is the single chokepoint. Upstream test confirms no thread needed. | Very High | Architecture, UX |
| 2 | **Empirical proof: ephemeral app-server returns 32 skills in 877ms with no session.** Spawning `codex app-server`, sending `initialize`, `initialized`, then `skills/list` works perfectly. Timing: spawn=6ms, initialize=582ms, skills/list=290ms. No API key validation or network call is needed for skill discovery. | Live test on local machine with `codex-cli 0.104.0`. Full skill list returned with scope, enabled, path, interface metadata. | Very High | Performance |
| 3 | **Direct SKILL.md parsing is 6.5x faster (135ms vs 877ms).** Skills on disk are discovered by scanning directories for `SKILL.md` files with YAML frontmatter (`name`, `description`, optional `metadata.short-description`). No `SKILL.json` files exist in practice. Parsing frontmatter from 32 skills across `~/.codex/skills/`, `~/.codex/skills/local/`, `~/.codex/skills/.system/`, and `~/.agents/skills/` takes 135ms in Python. | `~/.codex/skills/local/*/SKILL.md` -- all use `---\nname: ...\ndescription: ...\n---` frontmatter. Zero `SKILL.json` files found. | High | Performance, Architecture |
| 4 | **The skill discovery paths are well-defined.** Upstream `loader.rs` scans: User scope = `$CODEX_HOME/skills` + `~/.agents/skills`; Repo scope = `.codex/skills` + `.agents/skills` (walked up); System scope = `$CODEX_HOME/skills/.system`; Admin scope = `/etc/codex/skills`. Max depth = 6, max dirs per root = 2000, skips hidden dirs (except `.system`). | Upstream `codex-rs/core/src/skills/loader.rs`, confirmed by local filesystem inspection. `.codex-system-skills.marker` file contains hash `d9c5b31d2059f436`. | High | Architecture |
| 5 | **The `SkillsListParams` schema supports `cwds: []` (empty array).** When `cwds` is empty, it "defaults to the current session working directory." But since we can provide an explicit `cwd`, we never need a session's cwd at all. | `codex-rs/app-server-protocol/schema/json/v2/SkillsListParams.json` -- `cwds` is just `array of string`, `forceReload` is `boolean`. | Very High | Architecture |
| 6 | **The full data flow has 5 hops, each adding latency for no gain.** UI `$` trigger -> `skillsReactQuery.ts` queryFn -> WS `skills.list` -> `ProviderService.listSkills` (fans out across all adapters) -> `CodexAdapter.listSkills` -> `CodexAppServerManager.listSkills` -> borrows an existing session's stdio channel. | Traced: `composer-logic.ts:152-158` -> `ChatView.tsx:1216-1221` -> `skillsReactQuery.ts:19-25` -> `wsNativeApi.ts:186` -> `wsServer.ts:880-883` -> `ProviderService.ts:476-484` -> `CodexAdapter.ts:1494-1498` -> `codexAppServerManager.ts:879-937` | Very High | Architecture, UX |
| 7 | **The `ProviderService.listSkills` fans out to ALL adapters concurrently.** It calls `Effect.forEach(adapters, (adapter) => adapter.listSkills(cwd), { concurrency: "unbounded" })`. Currently only Codex is registered, but this means any future provider would also need to implement `listSkills`, even if it has no concept of skills. | `apps/server/src/provider/Layers/ProviderService.ts:476-484` | Medium | Architecture |
| 8 | **Skills are query-fetched lazily on `$` trigger, not prefetched.** The `enabled: isSkillTrigger` flag means the React Query only fires when the user types `$`. The 30-second stale time (`SKILLS_STALE_TIME = 30_000`) means repeated `$` presses within 30s use cached data, but the first press after app open always hits the server. | `apps/web/src/lib/skillsReactQuery.ts:11,16-28`, `ChatView.tsx:1219` | Very High | UX |
| 9 | **The `Skill` contract schema is a subset of what Codex returns.** The contract `Skill` has `name, description, path?, enabled, interface?` but Codex also returns `scope` (user/repo/system/admin), `shortDescription`, `dependencies`, `brandColor`, `iconSmall`, `iconLarge`, `defaultPrompt`. These are discarded by `codexAppServerManager.ts:904-931`. | `packages/contracts/src/skill.ts:7-20` vs `codex-rs/app-server-protocol/schema/json/v2/SkillsListResponse.json` `SkillMetadata` definition. | Very High | UI/UX (scope badges, icons) |
| 10 | **The `config.toml` does NOT store skill enable/disable state.** No `[skills]` section exists. Skill enablement appears to be determined at discovery time by the loader, likely from a separate state file or the `state_5.sqlite` database. | `~/.codex/config.toml` -- inspected full file, no skills configuration present. | Medium | Architecture |

### Blind Spots
Things this perspective CANNOT see (important for synthesis):
- **UX design intent** -- Why skills are lazy-loaded on `$` trigger rather than prefetched. There may be a deliberate UX reason (e.g., not showing stale skills, or keeping first-paint fast).
- **Future provider strategy** -- Whether the fan-out through `ProviderService` is architectural foresight for multi-provider skill aggregation, or accidental complexity.
- **Error UX** -- What happens when the user types `$` and gets an empty list because no session exists. The current behavior silently returns `[]` which makes skills appear non-existent rather than unavailable.
- **Security implications** -- Whether spawning an ephemeral app-server process for read-only skill discovery introduces any new attack surface or resource concerns.
- **Codex CLI upgrade path** -- Whether future Codex versions might change the `skills/list` protocol or require authentication for skill listing.

### Crossover Points
Connections to other possible perspectives:
- **Architecture/Design**: The empirical finding that an ephemeral app-server works without a session opens three architectural options: (A) maintain a persistent "skills-only" app-server process, (B) spawn ephemeral app-server on demand, (C) bypass app-server entirely and scan SKILL.md files directly in Node.js. Option C is fastest (135ms) but duplicates upstream logic and could drift. Option A is most elegant -- a lightweight app-server kept alive for metadata queries.
- **Performance**: The 877ms ephemeral roundtrip is acceptable for a first `$` press but wasteful if repeated. A persistent lightweight app-server (initialized once at T3 Code startup) would amortize the 582ms initialize cost to zero for subsequent queries.
- **UX/Product**: The `scope` field (user/repo/system/admin) is currently discarded but could power useful UI affordances -- showing repo-specific skills differently from global ones, or grouping by scope.
- **Reliability**: Direct filesystem scanning (Option C) is the most resilient approach -- no process lifecycle to manage, no stdio failure modes. But it would not get the benefit of Codex's internal caching, plugin-provided skill roots, or future skill discovery mechanisms.
- **Security**: The ephemeral app-server approach does not require an API key for `skills/list` (empirically verified). This is important -- it means skill discovery is a pure local-filesystem operation at the Codex level.

### Methodology
- Files examined:
  - `apps/server/src/codexAppServerManager.ts` (full file, 1400+ lines)
  - `apps/server/src/provider/Layers/CodexAdapter.ts:1494-1498`
  - `apps/server/src/provider/Layers/ProviderService.ts:476-484`
  - `apps/server/src/provider/Services/ProviderAdapter.ts:129-131`
  - `apps/server/src/provider/Services/ProviderService.ts:104-108`
  - `apps/server/src/wsServer.ts:880-884`
  - `apps/web/src/lib/skillsReactQuery.ts` (full file)
  - `apps/web/src/nativeApi.ts` (full file)
  - `apps/web/src/wsNativeApi.ts:186`
  - `apps/web/src/components/ChatView.tsx:1216-1312`
  - `apps/web/src/composer-logic.ts:110-171`
  - `packages/contracts/src/skill.ts` (full file)
  - `~/.codex/config.toml`
  - `~/.codex/skills/` directory tree
  - Upstream: `codex-rs/app-server-protocol/schema/json/v2/SkillsListParams.json`
  - Upstream: `codex-rs/app-server-protocol/schema/json/v2/SkillsListResponse.json`
  - Upstream: `codex-rs/core/src/skills/loader.rs` (via WebFetch)
  - Upstream: `codex-rs/core/src/skills/manager.rs` (via WebFetch)
  - Upstream: `codex-rs/app-server/tests/suite/v2/skills_list.rs` (via WebFetch)
- Searches performed:
  - `skills` across all server source
  - `listSkills` across all server source
  - `skillsList|skills\.list|WS_METHODS` project-wide
  - `isSkillTrigger|composerTrigger|skillTrigger` in web source
  - `detectComposerTrigger` in web source
  - `sendRequest` and `spawn.*codex` in codexAppServerManager
  - `CodexSkill` in codexAppServerManager
  - Upstream repo tree search for `skill` in filenames
  - `SKILL.json` and `SKILL.md` file discovery on local disk
- Live experiments:
  - Spawned ephemeral `codex app-server` process, sent `initialize` + `skills/list` without any session -- received 32 skills successfully
  - Measured timing: spawn=6ms, initialize=582ms, skills/list=290ms, total=877ms
  - Tested direct SKILL.md YAML frontmatter parsing: 32 skills in 135ms
  - Confirmed no SKILL.json files exist in practice
  - Confirmed `config.toml` has no skill-related configuration
- Dead ends:
  - `codex-rs/core/src/skills.rs` (404 -- skills is a module directory, not a single file)
  - Initial `providerManager.ts` search (file does not exist; functionality lives in `provider/Layers/ProviderService.ts`)
