/**
 * Escapes the LIKE/ILIKE wildcards in user input so it is matched literally: a search for "50%"
 * must not match every row, and "_" must not match any single character. Postgres's default
 * escape character is the backslash, so it is escaped too.
 */
export function escapeLike(input: string): string {
    return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}
