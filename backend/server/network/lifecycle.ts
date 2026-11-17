/** Threat lifecycle (pure). Transitions go both ways; every change is recorded by the service. */
import { Status } from './model';

export const TRANSITIONS: Record<Status, Status[]> = {
  REPORTED: ['UNDER_REVIEW', 'SUSPECTED', 'VERIFIED', 'FALSE_POSITIVE', 'REVOKED'],
  UNDER_REVIEW: ['SUSPECTED', 'VERIFIED', 'FALSE_POSITIVE', 'REVOKED', 'DISPUTED', 'REPORTED'],
  SUSPECTED: ['UNDER_REVIEW', 'VERIFIED', 'FALSE_POSITIVE', 'REVOKED', 'DISPUTED', 'EXPIRED'],
  VERIFIED: ['DISPUTED', 'REVOKED', 'EXPIRED', 'FALSE_POSITIVE', 'UNDER_REVIEW'],
  DISPUTED: ['UNDER_REVIEW', 'VERIFIED', 'SUSPECTED', 'REVOKED', 'FALSE_POSITIVE'],
  REVOKED: ['UNDER_REVIEW'],
  EXPIRED: ['UNDER_REVIEW', 'SUSPECTED'],
  FALSE_POSITIVE: ['UNDER_REVIEW'],
};
export const canTransition = (from: Status, to: Status) => TRANSITIONS[from].includes(to);

/** Reviewer actions → target status. `verify` may need a second reviewer (see service). */
export const ACTIONS = { review: 'UNDER_REVIEW', suspect: 'SUSPECTED', verify: 'VERIFIED', dispute: 'DISPUTED', revoke: 'REVOKED', false_positive: 'FALSE_POSITIVE' } as const;
export type ReviewAction = keyof typeof ACTIONS;

export const EVENT_FOR: Partial<Record<Status, string>> = {
  SUSPECTED: 'threat.reported', VERIFIED: 'threat.verified', DISPUTED: 'threat.disputed', REVOKED: 'threat.revoked', EXPIRED: 'threat.expired', FALSE_POSITIVE: 'threat.false_positive',
};

/** Default lifetime of an active indicator before it must be re-confirmed. */
export const TTL_DAYS: Partial<Record<Status, number>> = { SUSPECTED: 30, VERIFIED: 180 };
