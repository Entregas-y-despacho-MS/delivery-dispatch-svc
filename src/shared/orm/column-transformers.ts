import { ValueTransformer } from 'typeorm';

// pg returns NUMERIC columns as strings to avoid float precision loss — for values that are safe
// as plain numbers (capacities, not money), convert so the API returns 1500.5 instead of "1500.50".
export const numericTransformer: ValueTransformer = {
    to:   (value?: number | null) => value,
    from: (value?: string | null) => (value === null || value === undefined ? value : Number(value)),
};
