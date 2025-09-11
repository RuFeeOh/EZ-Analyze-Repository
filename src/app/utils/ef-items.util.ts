/* Utility for shaping Exceedance Fraction items from raw exposure group documents.
 * All functions here are pure (except for an internal WeakMap-based memo cache) to allow
 * straightforward unit testing and potential reuse across components or server functions.
 */

export type EfBucket = 'good' | 'warn' | 'bad';
export interface ExceedanceFractionHistoryEntry {
    DateCalculated?: string;
    ExceedanceFraction?: number;
    OELNumber?: number | null;
    ResultsUsed?: any[];
}

export interface ExposureGroupRaw {
    ExposureGroup?: string; // preferred name
    Group?: string;         // fallback name property
    ExceedanceFractionHistory?: ExceedanceFractionHistoryEntry[];
    LatestExceedanceFraction?: ExceedanceFractionHistoryEntry;
    [key: string]: any; // allow other properties
}

export interface ExceedanceFractionItem {
    Uid: string;
    ExposureGroup: string;
    Agent: string;
    OELNumber: number | null;
    ExceedanceFraction: number;
    EfBucket: EfBucket;
    DateCalculated: string;
    SamplesUsed: number;
    ResultsUsed: any[];
    PrevExceedanceFraction: number | null;
    PrevDateCalculated: string;
    Trend: 'up' | 'down' | 'flat';
    Delta: number; // current - previous (0 if first / unknown)
}

function bucketFor(val: number | null | undefined): EfBucket {
    const v = typeof val === 'number' ? val : 0;
    if (v < 0.05) return 'good';
    if (v < 0.20) return 'warn';
    return 'bad';
}

// Simple signature builder for a group's history to know if we must recompute sorting.
function historySignature(hist: ExceedanceFractionHistoryEntry[] | undefined): string {
    if (!hist || !hist.length) return '0';
    const len = hist.length;
    const last = hist[len - 1];
    return `${len}:${last?.DateCalculated ?? 'no-date'}`;
}

interface GroupCacheEntry {
    asc: ExceedanceFractionHistoryEntry[]; // ascending by date
    desc: ExceedanceFractionHistoryEntry[]; // descending by date
    signature: string;
}

const groupHistoryCache = new WeakMap<ExposureGroupRaw, GroupCacheEntry>();

function getSortedHistories(group: ExposureGroupRaw): GroupCacheEntry {
    const rawHist = (group.ExceedanceFractionHistory || []).slice();
    const sig = historySignature(rawHist);
    const cached = groupHistoryCache.get(group);
    if (cached && cached.signature === sig) return cached;
    // Sort once ascending; derive descending via reverse copy
    const asc = rawHist.sort((a, b) => new Date(a?.DateCalculated || 0).getTime() - new Date(b?.DateCalculated || 0).getTime());
    const desc = asc.slice().reverse();
    const entry: GroupCacheEntry = { asc, desc, signature: sig };
    groupHistoryCache.set(group, entry);
    return entry;
}

function firstAgent(results: any[]): string {
    if (!Array.isArray(results)) return '';
    const found = results.find(r => !!r?.Agent);
    return found?.Agent ?? '';
}

export function buildHistoryEfItems(groups: ExposureGroupRaw[] | undefined | null): ExceedanceFractionItem[] {
    if (!groups || !groups.length) return [];
    const items: ExceedanceFractionItem[] = [];
    for (const g of groups) {
        const name = g?.ExposureGroup ?? g?.Group ?? '';
        if (!name) continue;
        const { asc } = getSortedHistories(g);
        asc.forEach((ef, idx) => {
            const prev = idx > 0 ? asc[idx - 1] : undefined;
            const prevVal = prev?.ExceedanceFraction ?? null;
            const currVal = ef?.ExceedanceFraction ?? 0;
            let trend: 'up' | 'down' | 'flat' = 'flat';
            if (prevVal != null) {
                if (currVal > prevVal) trend = 'up';
                else if (currVal < prevVal) trend = 'down';
            }
            const delta = prevVal != null ? (currVal - prevVal) : 0;
            const results = ef?.ResultsUsed ?? [];
            items.push({
                Uid: `${name}__${ef?.DateCalculated || 'no-date'}__${idx}`,
                ExposureGroup: name,
                Agent: firstAgent(results),
                OELNumber: ef?.OELNumber ?? g?.LatestExceedanceFraction?.OELNumber ?? null,
                ExceedanceFraction: currVal,
                EfBucket: bucketFor(currVal),
                DateCalculated: ef?.DateCalculated ?? '',
                SamplesUsed: results.length || 0,
                ResultsUsed: results,
                PrevExceedanceFraction: prevVal,
                PrevDateCalculated: prev?.DateCalculated ?? '',
                Trend: trend,
                Delta: delta,
            });
        });
    }
    // Global sort descending by date
    return items.sort((a, b) => new Date(b.DateCalculated || 0).getTime() - new Date(a.DateCalculated || 0).getTime());
}

export function buildLatestEfItems(groups: ExposureGroupRaw[] | undefined | null): ExceedanceFractionItem[] {
    if (!groups || !groups.length) return [];
    const items: ExceedanceFractionItem[] = [];
    for (const g of groups) {
        const name = g?.ExposureGroup ?? g?.Group ?? '';
        if (!name) continue;
        const { desc } = getSortedHistories(g);
        const latest = desc[0] || g.LatestExceedanceFraction;
        if (!latest) continue;
        let trend: 'up' | 'down' | 'flat' = 'flat';
        let delta = 0;
        if (desc.length >= 2) {
            const curr = latest?.ExceedanceFraction ?? null;
            const prev = desc[1]?.ExceedanceFraction ?? null;
            if (curr != null && prev != null) {
                if (curr > prev) trend = 'up';
                else if (curr < prev) trend = 'down';
                delta = curr - prev;
            }
        }
        const results = latest?.ResultsUsed ?? [];
        const prevEntry = desc.length >= 2 ? desc[1] : undefined;
        items.push({
            Uid: `${name}__latest__${latest?.DateCalculated || 'no-date'}`,
            ExposureGroup: name,
            Agent: firstAgent(results),
            OELNumber: latest?.OELNumber ?? g?.LatestExceedanceFraction?.OELNumber ?? null,
            ExceedanceFraction: latest?.ExceedanceFraction ?? 0,
            EfBucket: bucketFor(latest?.ExceedanceFraction ?? 0),
            DateCalculated: latest?.DateCalculated ?? '',
            SamplesUsed: results.length || 0,
            ResultsUsed: results,
            Trend: trend,
            Delta: delta,
            PrevExceedanceFraction: prevEntry?.ExceedanceFraction ?? null,
            PrevDateCalculated: prevEntry?.DateCalculated ?? '',
        });
    }
    return items.sort((a, b) => new Date(b.DateCalculated || 0).getTime() - new Date(a.DateCalculated || 0).getTime());
}
