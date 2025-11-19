import { ImportSampleInfo } from "../models/import-sample-info.model";
import { SampleInfo } from "../models/sample-info.model";
import { normalizeAgent, slugifyAgent } from "./agent";

/**
 * Normalize the incoming sample result for import.
 * @param r The raw sample result.
 * @param jobId The ID of the import job.
 * @param g The group information.
 * @param isExisting Whether the result is for an existing sample.
 * @returns The normalized sample information.
 */
export function normalizeResults(
    r: any,
    jobId: string | null,
    g: { groupName: string },
    isExisting = false
): ImportSampleInfo {
    const sampleNumberRaw = r?.SampleNumber;
    const twaRaw = r?.TWA;
    const twa = (twaRaw === '' || twaRaw === undefined || twaRaw === null) ? null : Number(twaRaw);
    const agentRaw = typeof r?.Agent === 'string' ? r.Agent.trim() : '';
    const agentKey = (r?.AgentKey && typeof r.AgentKey === 'string') ? r.AgentKey : normalizeAgent(agentRaw).key;
    return {
        SampleNumber: (sampleNumberRaw === undefined || sampleNumberRaw === '') ? null : sampleNumberRaw,
        SampleDate: r?.SampleDate ?? "",
        ExposureGroup: r?.ExposureGroup || r?.Group || g.groupName,
        Agent: agentRaw,
        AgentKey: agentKey,
        TWA: (twa === null || Number.isNaN(twa)) ? 0 : twa,
        Notes: r?.Notes ?? "",
        ImportJobId: isExisting ? (r?.ImportJobId ?? null) : jobId,
        Group: "",
    };
};

/**
 * this method creates a map of sample+agentKey to TWA value for quick lookup
 * @param arr 
 * @returns 
 */
export function toKeySignatureMap(arr: SampleInfo[]): Map<string, { twa: number | null; agentKey: string; }> {
    const m = new Map<string, { twa: number | null; agentKey: string; }>();
    for (const r of (arr || [])) {
        const { compound, agentKey } = getRowKeyVariants(r);
        if (!compound) continue;
        const twaRaw = (r?.TWA === '' || r?.TWA === undefined || r?.TWA === null) ? null : Number(r.TWA);
        const twaVal = (twaRaw === null || Number.isNaN(twaRaw)) ? null : twaRaw;
        m.set(compound, { twa: twaVal, agentKey });
    }
    return m;
};

/**
 * This method generates key variants for a sample result.
 * @param result 
 * @returns 
 */
export function getRowKeyVariants(result: SampleInfo): { sample: string | null; compound: string | null; agentKey: string } {
    const sample = normalizeSampleNumber(result.SampleNumber);
    const agentKey = resolveAgentKeyFromResult(result);
    return {
        sample,
        agentKey,
        compound: sample ? `${sample}::${agentKey}` : null,
    };
}


export function normalizeSampleNumber(value: any): string | null {
    if (value === undefined || value === null) return null;
    const str = String(value).trim();
    return str ? str : null;
}

export function resolveAgentKeyFromResult(result: SampleInfo): string {
    const keyRaw = typeof result?.AgentKey === 'string' ? result.AgentKey.trim() : '';
    if (keyRaw) return slugifyAgent(keyRaw);
    return normalizeAgent(result?.Agent).key;
}

export function compactResults(results: SampleInfo[] | undefined): any[] {
    if (!Array.isArray(results)) return [];
    return results.map(r => ({
        SampleNumber: r?.SampleNumber ?? null,
        SampleDate: r?.SampleDate ?? null,
        TWA: r?.TWA ?? null,
        Agent: r?.Agent ?? '',
        AgentKey: r?.AgentKey ?? null,
    }));
}
