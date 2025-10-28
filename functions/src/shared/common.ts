

export function normalizeSampleNumber(value: any): string | null {
    if (value === undefined || value === null) return null;
    const str = String(value).trim();
    return str ? str : null;
}