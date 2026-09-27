// Shared queries (one cache key per resource, so every screen sees the same data).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { hasPerm, op, type Me } from "./api";
import type {
  Approval,
  CloseReason,
  DirectoryUser,
  EngagementType,
  ProjectDetail,
  ProjectRow,
  ProjectType,
  RateCard,
  RateCardDetail,
  ScopeDetail,
} from "./types";

export const useEngagementTypes = (me: Me) =>
  useQuery({
    queryKey: ["engagement-types"],
    enabled: hasPerm(me, "pricing.view"),
    queryFn: () => op<EngagementType[]>("engagement_type.list", {}),
    staleTime: 60_000,
  });

export const useProjectTypes = (me: Me) =>
  useQuery({
    queryKey: ["project-types"],
    enabled: hasPerm(me, "pricing.view"),
    queryFn: () => op<ProjectType[]>("project_type.list", {}),
    staleTime: 60_000,
  });

export const useRateCards = (me: Me) =>
  useQuery({
    queryKey: ["rate-cards"],
    enabled: hasPerm(me, "pricing.view"),
    queryFn: () => op<RateCard[]>("rate_card.list", {}),
    staleTime: 60_000,
  });

export const useRateCard = (me: Me, id: string | null) =>
  useQuery({
    queryKey: ["rate-card", id],
    enabled: !!id && hasPerm(me, "pricing.view"),
    queryFn: () => op<RateCardDetail>("rate_card.get", { id }),
    staleTime: 60_000,
  });

export const useInbox = (me: Me, include: "pending" | "recent" = "pending") =>
  useQuery({
    queryKey: ["approvals", include],
    enabled: hasPerm(me, "approval.view"),
    queryFn: () => op<Approval[]>("approval.inbox", { include }),
    refetchInterval: 60_000,
  });

// ---- S3 ----------------------------------------------------------------------------------------
export const useDirectory = (me: Me) =>
  useQuery({
    queryKey: ["users"],
    enabled: hasPerm(me, "user.directory"),
    queryFn: () => op<DirectoryUser[]>("user.directory", {}),
    staleTime: 60_000,
  });

export const useWinReasons = () =>
  useQuery({
    queryKey: ["close-reasons", "won"],
    queryFn: () => op<CloseReason[]>("close_reason.list", { kind: "won" }),
    staleTime: 60_000,
  });

export const useProject = (id: string) =>
  useQuery({ queryKey: ["project", id], queryFn: () => op<ProjectDetail>("project.get", { id }) });

export const useScope = (projectId: string, enabled = true) =>
  useQuery({ queryKey: ["scope", projectId], enabled, queryFn: () => op<ScopeDetail | null>("scope.get", { projectId }) });

/** Everything that shows project data refreshes after a project write. */
export function useProjectRefresh(projectId: string) {
  const qc = useQueryClient();
  const keys = [
    ["project", projectId],
    ["projects"],
    ["task-board", projectId],
    ["scope", projectId],
    ["change-orders", projectId],
    ["my-tasks"],
    ["approvals"],
  ];
  return () => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })));
}

/** Open projects (or all), mine or everyone's, with their uncovered gates. */
export const useProjects = (me: Me, mine: boolean, includeClosed = false) =>
  useQuery({
    queryKey: ["projects", mine, includeClosed],
    enabled: hasPerm(me, "project.view"),
    queryFn: () => op<ProjectRow[]>("project.list", { mine, includeClosed }),
  });
