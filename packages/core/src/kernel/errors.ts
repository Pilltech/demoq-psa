import { ERROR_STATUS, type ErrorCode } from "@demoq/shared";

/** A rule said no. Carries a stable code; adapters turn it into problem+json in en or km. */
export class DomainError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    readonly params: Record<string, unknown> = {},
    detail?: string,
  ) {
    super(detail ?? code);
    this.status = ERROR_STATUS[code];
  }
}

export const fail = (code: ErrorCode, params?: Record<string, unknown>, detail?: string): never => {
  throw new DomainError(code, params, detail);
};
