/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';

admin.initializeApp();

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// export const helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

type SampleInfo = {
    SampleDate: string;
    ExposureGroup?: string;
    Group?: string;
    TWA: number | string;
    Notes?: string;
    SampleNumber?: string | number;
};

type ExceedanceFraction = {
    ExceedanceFraction: number;
    DateCalculated: string;
    OELNumber: number;
    MostRecentNumber: number;
    ResultsUsed: SampleInfo[];
};

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

// Exceedance Fraction calculation (same as client service)
function normalCDF(x: number) {
    return (1 - erf(-x / Math.sqrt(2))) / 2;
}
function erf(x: number) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
}
function calculateExceedanceProbability(measurements: number[], OEL: number): number {
    const logMeasurements = measurements.map(x => Math.log(x));
    const mean = logMeasurements.reduce((sum, val) => sum + val, 0) / logMeasurements.length;
    const variance = logMeasurements.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (logMeasurements.length - 1);
    const stdDev = Math.sqrt(variance);
    const logOEL = Math.log(OEL);
    const zScore = (logOEL - mean) / stdDev;
    const exceedanceProbability = 1 - normalCDF(zScore);
    return exceedanceProbability;
}

function createExceedanceFraction(exceedanceFraction: number, resultsUsed: SampleInfo[], TWAlist: number[]): ExceedanceFraction {
    return {
        ExceedanceFraction: exceedanceFraction,
        DateCalculated: new Date().toISOString(),
        OELNumber: 0.05,
        MostRecentNumber: TWAlist.length,
        ResultsUsed: resultsUsed,
    };
}

export const recomputeExceedanceFraction = onDocumentWritten("organizations/{orgId}/exposureGroups/{docId}", async (event: any) => {
    const before = event.data?.before?.data() as any | undefined;
    const after = event.data?.after?.data() as any | undefined;
    const docId = event.params.docId as string;
    if (!after) {
        logger.info(`EF trigger: document deleted, skipping: organizations/${event.params.orgId}/exposureGroups/${docId}`);
        return;
    }

    // Only recompute when Results changed or EF fields missing
    const beforeResultsStr = JSON.stringify(before?.Results || []);
    const afterResultsStr = JSON.stringify(after.Results || []);
    const efMissing = !after.LatestExceedanceFraction || !Array.isArray(after.ExceedanceFractionHistory);
    if (!efMissing && beforeResultsStr === afterResultsStr) {
        logger.info(`EF trigger: no change in Results and EF present, skipping for ${docId}`);
        return;
    }

    const db = getFirestore();
    const orgId = event.params.orgId as string;
    const ref = db.doc(`organizations/${orgId}/exposureGroups/${docId}`);

    await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const data = snap.data() || {} as any;
        const results: SampleInfo[] = (data.Results || []) as SampleInfo[];
        const mostRecent = getMostRecentSamples(results, 6);
        const TWAlist = mostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
        const ef = (TWAlist.length >= 2) ? calculateExceedanceProbability(TWAlist, 0.05) : 0;
        const latest = createExceedanceFraction(ef, mostRecent, TWAlist);
        const history: ExceedanceFraction[] = Array.isArray(data.ExceedanceFractionHistory) ? data.ExceedanceFractionHistory : [];
        const updatedHistory = [...history, latest];

        tx.update(ref, {
            LatestExceedanceFraction: latest,
            ExceedanceFractionHistory: updatedHistory,
        });
    });

    logger.info(`Recomputed EF for organizations/${event.params.orgId}/exposureGroups/${docId}`);
});

// Maintain a total count of results on the parent doc using subcollection writes
export const maintainResultsTotalCount = onDocumentWritten("organizations/{orgId}/exposureGroups/{groupId}/results/{resultId}", async (event: any) => {
    const orgId = event.params.orgId as string;
    const groupId = event.params.groupId as string;
    const beforeExists = !!event.data?.before?.exists;
    const afterExists = !!event.data?.after?.exists;
    if (beforeExists === afterExists) {
        // Pure update, no net count change
        return;
    }
    const db = getFirestore();
    const parentRef = db.doc(`organizations/${orgId}/exposureGroups/${groupId}`);
    const delta = (!beforeExists && afterExists) ? 1 : -1;
    await parentRef.set({ ResultsTotalCount: FieldValue.increment(delta) }, { merge: true });
    logger.info(`ResultsTotalCount ${delta > 0 ? '++' : '--'} for org ${orgId} group ${groupId}`);
});

// --- Audit logs (write-once by Functions) ---
type AuditLog = {
    // ISO timestamp when the edit occurred (server time)
    at: string;
    actorUid?: string;
    editedBy?: string;
    action: 'create' | 'update' | 'delete';
    documentPath: string;
    collection: string;
    docId: string;
    diff?: any;
    source?: string;
    batchId?: string;
    expireAt?: admin.firestore.Timestamp;
};

function computeDiff(before: any, after: any) {
    // If entire object created or deleted, show full added object or a removedAll flag
    if (!before && after) return { added: after };
    if (before && !after) return { removedAll: true };

    const isPlainObject = (val: any) => val !== null && typeof val === 'object' && !Array.isArray(val);

    function summarizeValue(v: any) {
        if (Array.isArray(v)) {
            return {
                _type: "array",
                latest: v.slice(0, Math.min(1, v.length)),
            };
        }
        return v;
    }

    function diffArrays(bArr: any[], aArr: any[]) {
        try {
            const same = JSON.stringify(bArr) === JSON.stringify(aArr);
            if (same) return null;
        } catch { /* ignore stringify errors */ }
        return {
            _type: 'array',
            beforeLength: Array.isArray(bArr) ? bArr.length : undefined,
            afterLength: Array.isArray(aArr) ? aArr.length : undefined,
            latestBefore: Array.isArray(bArr) ? bArr.slice(0, Math.min(1, bArr.length)) : undefined,
            latestAfter: Array.isArray(aArr) ? aArr.slice(0, Math.min(1, aArr.length)) : undefined,
        };
    }

    function diffValues(bv: any, av: any): any | null {
        if (bv === undefined && av !== undefined) return { added: summarizeValue(av) };
        if (bv !== undefined && av === undefined) return { removed: summarizeValue(bv) };
        if (isPlainObject(bv) && isPlainObject(av)) return diffObjects(bv, av);
        if (Array.isArray(bv) && Array.isArray(av)) return diffArrays(bv, av);
        const same = ((): boolean => {
            try { return JSON.stringify(bv) === JSON.stringify(av); } catch { return bv === av; }
        })();
        if (same) return null;
        return { before: summarizeValue(bv), after: summarizeValue(av) };
    }

    function diffObjects(bObj: Record<string, any>, aObj: Record<string, any>) {
        const changed: any = {};
        const added: Record<string, any> = {};
        const removed: Record<string, any> = {};
        const keys = new Set([...Object.keys(bObj || {}), ...Object.keys(aObj || {})]);
        for (const k of keys) {
            const hasB = Object.prototype.hasOwnProperty.call(bObj || {}, k);
            const hasA = Object.prototype.hasOwnProperty.call(aObj || {}, k);
            if (!hasB && hasA) { added[k] = summarizeValue(aObj[k]); continue; }
            if (hasB && !hasA) { removed[k] = summarizeValue(bObj[k]); continue; }
            const child = diffValues(bObj[k], aObj[k]);
            if (child) changed[k] = child;
        }
        return { changed, added, removed };
    }

    return diffObjects(before || {}, after || {});
}

const RETENTION_DAYS = parseInt(process.env.AUDIT_TTL_DAYS || '365', 10) * 2;

async function writeAudit(orgId: string, collection: string, docId: string, before: any, after: any) {
    const db = getFirestore();
    const path = `organizations/${orgId}/${collection}/${docId}`;
    const action: 'create' | 'update' | 'delete' = !before && after ? 'create' : before && !after ? 'delete' : 'update';
    const actorUid = after?.updatedBy || before?.updatedBy || undefined;
    const expireAt = Timestamp.fromDate(new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000));
    const nowIso = new Date().toISOString();
    const diff = computeDiff(before, after);

    const log: AuditLog = {
        at: nowIso,
        actorUid,
        editedBy: actorUid,
        action,
        documentPath: path,
        collection,
        docId,
        diff,
        source: 'function',
        expireAt,
    };

    try {
        const ref = await db.collection(`organizations/${orgId}/auditLogs`).add(log as any);
        logger.info('Audit log written', { orgId, collection, docId, logId: ref.id, action });
        return ref.id as string;
    } catch (err: any) {
        logger.error('Failed to write audit log', {
            orgId,
            collection,
            docId,
            action,
            error: err?.message || String(err),
            stack: err?.stack,
        });
        throw err;
    }
}

export const auditExposureGroups = onDocumentWritten("organizations/{orgId}/exposureGroups/{docId}", async (event: any) => {
    const orgId = event.params.orgId as string;
    const docId = event.params.docId as string;
    const beforeExists = !!event.data?.before?.exists;
    const afterExists = !!event.data?.after?.exists;
    const before = event.data?.before?.data() as any | undefined;
    const after = event.data?.after?.data() as any | undefined;

    logger.info('auditExposureGroups fired', {
        orgId,
        docId,
        beforeExists,
        afterExists,
        FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || 'not-set',
    });

    try {
        const logId = await writeAudit(orgId, 'exposureGroups', docId, before, after);
        logger.info('auditExposureGroups success', { orgId, docId, logId });
    } catch (err: any) {
        logger.error('auditExposureGroups error', { orgId, docId, error: err?.message || String(err) });
        // Rethrow to surface in emulator logs as failed invocation
        throw err;
    }
});

export const auditAgents = onDocumentWritten("organizations/{orgId}/agents/{docId}", async (event: any) => {
    const orgId = event.params.orgId as string;
    const docId = event.params.docId as string;
    const beforeExists = !!event.data?.before?.exists;
    const afterExists = !!event.data?.after?.exists;
    const before = event.data?.before?.data() as any | undefined;
    const after = event.data?.after?.data() as any | undefined;

    logger.info('auditAgents fired', {
        orgId,
        docId,
        beforeExists,
        afterExists,
        FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || 'not-set',
    });

    try {
        const logId = await writeAudit(orgId, 'agents', docId, before, after);
        logger.info('auditAgents success', { orgId, docId, logId });
    } catch (err: any) {
        logger.error('auditAgents error', { orgId, docId, error: err?.message || String(err) });
        throw err;
    }
});
