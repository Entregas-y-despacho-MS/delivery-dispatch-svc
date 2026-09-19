import bcrypt from 'bcrypt';

// bcrypt is intentionally slow (SALT_ROUNDS controls the cost factor).
// This makes brute-force attacks expensive while remaining imperceptible to users (~100ms).
// Each increment of SALT_ROUNDS doubles the computation time. 10 is the industry standard.
const SALT_ROUNDS = 10;

export const hashPassword = async (plainPassword: string): Promise<string> => {
    return bcrypt.hash(plainPassword, SALT_ROUNDS);
};

export const comparePassword = async (plainPassword: string, hashedPassword: string): Promise<boolean> => {
    return bcrypt.compare(plainPassword, hashedPassword);
};
