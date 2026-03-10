import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

// ── Skill schema ────────────────────────────────────────────────────
// Mirrors the shape returned by the Codex app-server `skills/list` response.

export const SkillInterface = Schema.Struct({
  displayName: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
});
export type SkillInterface = typeof SkillInterface.Type;

export const Skill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  path: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  interface: Schema.optional(SkillInterface),
});
export type Skill = typeof Skill.Type;

export const SkillsListInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type SkillsListInput = typeof SkillsListInput.Type;

export const SkillsListResult = Schema.Struct({
  skills: Schema.Array(Skill),
});
export type SkillsListResult = typeof SkillsListResult.Type;

export const CodexSkillSelection = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: Schema.optional(TrimmedNonEmptyString),
});
export type CodexSkillSelection = typeof CodexSkillSelection.Type;
