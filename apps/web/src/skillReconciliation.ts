import type { SkillSelection } from "./composerDraftStore";

/**
 * Filters skill selections to only those whose exact `$name` token still
 * appears in the prompt text. Used at send time to drop stale selections
 * after the user edits the prompt.
 */
export function reconcileSkillSelectionsAtSendTime(
  selections: ReadonlyArray<SkillSelection>,
  promptText: string,
): SkillSelection[] {
  return selections.filter((s) => {
    const pattern = new RegExp(`\\$${s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`);
    return pattern.test(promptText);
  });
}
