import type { SkillsListResult } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const skillsQueryKeys = {
  all: ["skills"] as const,
  list: (cwd: string | null) => ["skills", "list", cwd] as const,
};

const EMPTY_SKILLS_RESULT: SkillsListResult = { skills: [] };
const SKILLS_STALE_TIME = 30_000;

export function skillsListQueryOptions(input: {
  cwd: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: skillsQueryKeys.list(input.cwd),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Skills listing is unavailable without a workspace.");
      }
      return api.skills.list({ cwd: input.cwd });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: SKILLS_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SKILLS_RESULT,
  });
}
