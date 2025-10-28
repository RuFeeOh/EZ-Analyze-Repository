

export function normalizeSampleNumber(value: any): string | null {
    if (value === undefined || value === null) return null;
    const str = String(value).trim();
    return str ? str : null;
}

/**
 * Slugifies a string by converting it to lowercase, 
 * trimming whitespace, and 
 * replacing spaces with dashes.
 * @param text The input string to slugify.
 * @returns The slugified string.
 */
export function slugify(text: string): string {
    return (text || '').toLowerCase()
        .trim()
        .replace(/\s+/g, '-') // replace spaces with - (dashes)
        .replace(/[^a-z0-9\-]/g, '') // remove all non-alphanumeric chars except - (dashes)
        .replace(/-+/g, '-') // replace multiple - with single -
        .slice(0, 120); // limit length to 120 chars
}
