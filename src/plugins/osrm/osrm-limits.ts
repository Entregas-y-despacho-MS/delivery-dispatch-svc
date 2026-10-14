/**
 * Defaults of the OSRM plugin that are facts about the routing instance, not business rules, so
 * they live in `.env` (OSRM_TABLE_MAX_COORDINATES / OSRM_TIMEOUT_MS), never in `settings`.
 *
 * Measured on 2026-10-14 against osrm-backend v26.10.0 (MLD, default `--max-table-size`), see
 * scripts/osrm/measure-table-limit.mjs and the ST-50.2 decision:
 *  - `table` without sources/destinations accepts up to 100 coordinates (101 → `TooBig`).
 *  - with explicit sources and destinations the limit is `sources × destinations ≤ 100²`
 *    (100×100 and 50×150 pass; 101×100 is `TooBig`), not the number of coordinates.
 *  - a 100×100 matrix answers in ~250 ms; the URL is capped around 32 KB (≈ 800 coordinates).
 */
export const OSRM_TABLE_MAX_COORDINATES_DEFAULT = 100;

/** The routing engine must answer within this time or the caller gets a 503. */
export const OSRM_TIMEOUT_MS_DEFAULT = 5000;
