// RF-A31, Escenario 2 — a target time under 15 minutes is not a realistic delivery commitment.
export const MIN_TARGET_TIME_MIN = 15;
// Upper bound (30 days) only to reject absurd values; not a business rule from the story.
export const MAX_TARGET_TIME_MIN = 43200;
// priority_level is a SMALLINT.
export const MAX_PRIORITY_LEVEL = 32767;
