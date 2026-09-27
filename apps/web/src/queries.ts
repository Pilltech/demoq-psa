// Shared queries for S2 screens (one cache key per resource, so every screen sees the same data).
import { useQuery } from "@tanstack/react-query";
import { hasPerm, op, type Me } from "./api";
import type { Approval, EngagementType, ProjectType, RateCard, RateCardDetail } from "./types";

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
