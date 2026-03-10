import { describe, expect, it } from "vitest";
import { reconcileSkillSelectionsAtSendTime } from "./skillReconciliation";

describe("reconcileSkillSelectionsAtSendTime", () => {
  it("keeps selections whose $name token appears in the prompt", () => {
    const selections = [
      { name: "code-review", path: "/skills/code-review/SKILL.md" },
      { name: "deploy", path: "/skills/deploy/SKILL.md" },
    ];
    const prompt = "Please $code-review this PR and then $deploy it";

    const result = reconcileSkillSelectionsAtSendTime(selections, prompt);

    expect(result).toEqual(selections);
  });

  it("drops selections whose $name token was removed from the prompt", () => {
    const selections = [
      { name: "code-review", path: "/skills/code-review/SKILL.md" },
      { name: "deploy", path: "/skills/deploy/SKILL.md" },
    ];
    const prompt = "Please $code-review this PR";

    const result = reconcileSkillSelectionsAtSendTime(selections, prompt);

    expect(result).toEqual([{ name: "code-review", path: "/skills/code-review/SKILL.md" }]);
  });

  it("returns empty array when no selections match", () => {
    const selections = [{ name: "deploy", path: "/skills/deploy/SKILL.md" }];
    const prompt = "Just do something";

    const result = reconcileSkillSelectionsAtSendTime(selections, prompt);

    expect(result).toEqual([]);
  });

  it("returns empty array for empty selections", () => {
    const result = reconcileSkillSelectionsAtSendTime([], "any prompt $skill");

    expect(result).toEqual([]);
  });

  it("matches $code in $code-review since hyphen is a word boundary", () => {
    // Skill names use hyphens as separators. $code matches in "$code-review"
    // because "-" is not a word character. This is correct — if a user has
    // both $code and $code-review skills selected, both match.
    const selections = [{ name: "code", path: "/skills/code/SKILL.md" }];
    const prompt = "$code-review the changes";

    const result = reconcileSkillSelectionsAtSendTime(selections, prompt);

    expect(result).toEqual(selections);
  });

  it("does not match partial token names (alphanumeric continuation)", () => {
    const selections = [{ name: "code", path: "/skills/code/SKILL.md" }];
    const prompt = "$codeReview the changes";

    const result = reconcileSkillSelectionsAtSendTime(selections, prompt);

    expect(result).toEqual([]);
  });

  it("matches $name at end of prompt without trailing space", () => {
    const selections = [{ name: "deploy" }];
    const prompt = "Run $deploy";

    const result = reconcileSkillSelectionsAtSendTime(selections, prompt);

    expect(result).toEqual([{ name: "deploy" }]);
  });

  it("matches $name at start of prompt", () => {
    const selections = [{ name: "deploy" }];
    const prompt = "$deploy this project";

    const result = reconcileSkillSelectionsAtSendTime(selections, prompt);

    expect(result).toEqual([{ name: "deploy" }]);
  });

  it("handles skill names with regex-special characters", () => {
    const selections = [{ name: "skill.v2", path: "/skills/skill.v2/SKILL.md" }];
    const prompt = "Use $skill.v2 for this";

    const result = reconcileSkillSelectionsAtSendTime(selections, prompt);

    expect(result).toEqual(selections);
  });

  it("does not match when $name appears as substring of another word", () => {
    const selections = [{ name: "test" }];
    const prompt = "This is a $testing scenario";

    const result = reconcileSkillSelectionsAtSendTime(selections, prompt);

    expect(result).toEqual([]);
  });

  it("matches $name followed by punctuation", () => {
    const selections = [{ name: "deploy" }];
    const prompt = "Run $deploy, then check logs";

    const result = reconcileSkillSelectionsAtSendTime(selections, prompt);

    expect(result).toEqual([{ name: "deploy" }]);
  });

  it("handles selections without path", () => {
    const selections = [{ name: "my-skill" }];
    const prompt = "$my-skill do the thing";

    const result = reconcileSkillSelectionsAtSendTime(selections, prompt);

    expect(result).toEqual([{ name: "my-skill" }]);
  });
});
