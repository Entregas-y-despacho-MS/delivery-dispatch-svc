// Largest value of a Postgres INTEGER column (every *_id here). A bigger number reaches the query
// and comes back as a 500 ("out of range for type integer"), so it is rejected as a 400 instead.
export const INT4_MAX = 2_147_483_647;
