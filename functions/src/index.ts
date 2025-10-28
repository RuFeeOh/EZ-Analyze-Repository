/**
 * Import function triggers from their respective submodules:
    const jobRef = db.doc(`organizations/${orgId}/importJobs/${jobId}`);
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { SampleInfo } from "./models/sample-info.model";
import { AgentEfSnapshot } from "./models/agent-ef-snapshot.model";
import { calculateExceedanceProbability, createExceedanceFraction } from "./shared/ef";
import { Agent } from "./models/agent.model";
import { computeAgentEfState } from "./shared/import";

export { createOrganization, deleteOrganization, renameOrganization } from "./shared/organization";
export { bulkImportResults, undoImport } from "./shared/import";

admin.initializeApp();

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// export const helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });



function parseDateToEpoch(dateStr?: string | null): number {
    if (!dateStr) return 0;
    const t = new Date(dateStr).getTime();
    return isNaN(t) ? 0 : t;
}

function getMostRecentSamples(results: SampleInfo[] = [], max = 6): SampleInfo[] {
    const candidates = (results || []).filter(r => r && Number(r.TWA) > 0);
    const sorted = [...candidates].sort((a, b) => parseDateToEpoch(b.SampleDate) - parseDateToEpoch(a.SampleDate));
    return sorted.slice(0, Math.min(max, sorted.length));
}

function compactResults(results: SampleInfo[] | undefined): any[] {
    if (!Array.isArray(results)) return [];
    return results.map(r => ({
        SampleNumber: r?.SampleNumber ?? null,
        SampleDate: r?.SampleDate ?? null,
        TWA: r?.TWA ?? null,
        Agent: r?.Agent ?? '',
        AgentKey: r?.AgentKey ?? null,
    }));
}

function compactEfSnapshot(snapshot: any) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    return {
        ExceedanceFraction: typeof snapshot.ExceedanceFraction === 'number' ? snapshot.ExceedanceFraction : null,
        MostRecentNumber: typeof snapshot.MostRecentNumber === 'number' ? snapshot.MostRecentNumber : null,
        AgentKey: snapshot.AgentKey ?? null,
        AgentName: snapshot.AgentName ?? null,
        Results: compactResults(snapshot.ResultsUsed),
    };
}


function deepEqual(a: any, b: any): boolean {
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch {
        return false;
    }
}
// HTTPS callable to recompute EF for a set of groups
export const recomputeEfBatch = onCall(async (request) => {
    const { orgId, groupIds } = request.data || {};
    if (!orgId || !Array.isArray(groupIds) || groupIds.length === 0) {
        throw new Error('orgId and groupIds[] required');
    }
    const db = getFirestore();
    // Collect EfSummary entries for a single consolidated org update at the end
    const doOne = async (groupId: string) => {
        const parentRef = db.doc(`organizations/${orgId}/exposureGroups/${groupId}`);
        const snap = await parentRef.get();
        if (!snap.exists) return;
        const data = snap.data() || {} as any;
        const parentResults: SampleInfo[] = Array.isArray(data.Results) ? data.Results as any : [];
        const sorted = [...parentResults].sort((a, b) => parseDateToEpoch(b.SampleDate) - parseDateToEpoch(a.SampleDate)).slice(0, 30);
        const preview = getMostRecentSamples(sorted as any, 6);
        const agentEfState = computeAgentEfState(sorted as any, data?.LatestExceedanceFractionByAgent, data?.ExceedanceFractionHistoryByAgent);
        let topSnapshot = agentEfState.topSnapshot;
        if (!topSnapshot) {
            const fallbackMostRecent = getMostRecentSamples(sorted as any, 6);
            const fallbackTwa = fallbackMostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
            const fallbackAgent = new Agent({
                Name: 'Unknown',
                OELNumber: 0.05,
            })
            const fallback = createExceedanceFraction(
                (fallbackTwa.length >= 2) ? calculateExceedanceProbability(fallbackTwa, 0.05) : 0,
                fallbackMostRecent as any,
                fallbackTwa,
                fallbackAgent
            ) as AgentEfSnapshot;
            fallback.AgentKey = fallback.AgentKey || 'unknown';
            fallback.AgentName = fallback.AgentName || 'Unknown';
            topSnapshot = fallback;
        }
        const prevTopCompact = compactEfSnapshot(data?.LatestExceedanceFraction);
        const newTopCompact = compactEfSnapshot(topSnapshot);
        const topChanged = !deepEqual(prevTopCompact, newTopCompact);
        const byAgentSummary = Object.fromEntries(Object.entries(agentEfState.latestByAgent).map(([key, snap]) => [key, {
            Agent: snap.AgentName,
            AgentKey: snap.AgentKey,
            ExceedanceFraction: snap.ExceedanceFraction,
            DateCalculated: snap.DateCalculated,
            SamplesUsedCount: snap.MostRecentNumber,
        }]));
        const nowTs = Timestamp.now();
        const payload: any = {
            ResultsPreview: preview,
            Importing: false,
            updatedAt: nowTs,
            LatestExceedanceFractionByAgent: agentEfState.latestByAgent,
            ExceedanceFractionHistoryByAgent: agentEfState.historyByAgent,
        };
        if (topSnapshot && (topChanged || !data?.LatestExceedanceFraction)) {
            payload.LatestExceedanceFraction = topSnapshot;
            payload.ExceedanceFractionHistory = FieldValue.arrayUnion(topSnapshot as any);
            payload.EFComputedAt = nowTs;
        }
        await parentRef.set(payload, { merge: true });
        try {
            const entry = topSnapshot ? {
                GroupId: groupId,
                ExposureGroup: data.ExposureGroup || data.Group || groupId,
                ExceedanceFraction: topSnapshot.ExceedanceFraction,
                PreviousExceedanceFraction: prevTopCompact?.ExceedanceFraction ?? null,
                Agent: topSnapshot.AgentName ?? null,
                AgentKey: topSnapshot.AgentKey ?? null,
                OELNumber: topSnapshot.OELNumber,
                DateCalculated: topSnapshot.DateCalculated,
                SamplesUsedCount: topSnapshot.MostRecentNumber,
                ByAgent: byAgentSummary,
            } : null;
            return entry;
        } catch (e: any) {
            logger.warn('recomputeEfBatch: failed to build EfSummary entry', { orgId, groupId, error: e?.message || String(e) });
            return null;
        }
    };
    // Limit concurrency to avoid hot shards
    const pool = 10;
    const queue = [...groupIds];
    const orgSummaryUpdate: Record<string, any> = {};
    const workers: Promise<any>[] = new Array(Math.min(pool, queue.length)).fill(0).map(async () => {
        while (queue.length) {
            const id = queue.shift();
            if (!id) break;
            try {
                const entry = await doOne(id);
                if (entry) orgSummaryUpdate[`EfSummary.${id}`] = entry;
            } catch (e) {
                logger.error('recomputeEfBatch item failed', { id, error: (e as any)?.message || String(e) });
            }
        }
    });
    await Promise.all(workers);
    // Single consolidated write to organization doc at the end
    // Note: set(..., { merge: true }) on EfSummary.{groupId} achieves replace-or-create for each entry
    try {
        if (Object.keys(orgSummaryUpdate).length > 0) {
            const orgRef = db.doc(`organizations/${orgId}`);
            await orgRef.set(orgSummaryUpdate as any, { merge: true });
        }
    } catch (e: any) {
        logger.warn('recomputeEfBatch: failed to write consolidated EfSummary', { orgId, error: e?.message || String(e) });
    }
    return { ok: true, count: groupIds.length };
});
