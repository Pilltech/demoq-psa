// Deal pipeline machine (plan §4.3). Open stages move freely; Won/Lost are closes.
// Rules: specs/crm/close-reason.md (CRM-CR-*).
import { OPEN_STAGES, type DealStage, type OpenStage } from "@demoq/shared";
import { defineMachine } from "../kernel";

export const dealMachine = defineMachine({
  name: "deal",
  states: ["lead", "qualified", "proposal", "negotiation", "won", "lost"] as const satisfies readonly DealStage[],
  transitions: {
    move: { from: OPEN_STAGES, to: (s: DealStage) => s }, // target validated separately (any open stage)
    close_lost: { from: OPEN_STAGES, to: "lost" },
    // CRM-CR-03: Won only through quote.accept (S3), which requires a win reason.
    close_won: { from: OPEN_STAGES, to: "won" },
    reopen: { from: ["lost"], to: "qualified" }, // CRM-CR-04: Won is terminal
  },
});

export function isOpenStage(s: string): s is OpenStage {
  return (OPEN_STAGES as readonly string[]).includes(s);
}
