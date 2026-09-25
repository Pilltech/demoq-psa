import { DomainError } from "./errors";

/**
 * Declarative state machine. The same table drives the guard in core and the
 * Kanban columns / action buttons in the UI (exported through queries).
 */
export function defineMachine<S extends string, E extends string>(def: {
  name: string;
  states: readonly S[];
  transitions: Record<E, { from: readonly S[]; to: S | ((from: S) => S) }>;
}) {
  return {
    ...def,
    can(from: S, event: E): boolean {
      return def.transitions[event].from.includes(from);
    },
    assert(from: S, event: E): S {
      const t = def.transitions[event];
      if (!t.from.includes(from)) {
        throw new DomainError("INVALID_TRANSITION", { machine: def.name, from, event });
      }
      return typeof t.to === "function" ? t.to(from) : t.to;
    },
  };
}
