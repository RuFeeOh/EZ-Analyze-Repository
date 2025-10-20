/**
 * Import function triggers from their respective submodules:
    const jobRef = db.doc(`organizations/${orgId}/importJobs/${jobId}`);
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
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
    Agent?: string;
    AgentKey?: string;
};

type ExceedanceFraction = {
    ExceedanceFraction: number;
    DateCalculated: string;
    OELNumber: number;
    MostRecentNumber: number;
    ResultsUsed: SampleInfo[];
    AgentKey?: string;
    AgentName?: string;
};

type AgentNormalization = { key: string; name: string };

type AgentEfSnapshot = ExceedanceFraction & { AgentKey: string; AgentName: string };

interface AgentEfState {
    latestByAgent: Record<string, AgentEfSnapshot>;
    historyByAgent: Record<string, AgentEfSnapshot[]>;
    topSnapshot: AgentEfSnapshot | null;
    topAgentKey: string | null;
    changedAgentKeys: Set<string>;
    removedAgentKeys: Set<string>;
}

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

function slugifyAgent(value: string): string {
    return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 120) || 'unknown';
}

function normalizeAgent(raw: string | null | undefined): AgentNormalization {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return { key: 'unknown', name: 'Unknown' };
    return { key: slugifyAgent(value), name: value };
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

function almostEqual(a: number | null | undefined, b: number | null | undefined, epsilon = 1e-6): boolean {
    const av = typeof a === 'number' ? a : 0;
    const bv = typeof b === 'number' ? b : 0;
    return Math.abs(av - bv) <= epsilon;
}

function normalizeLatestMap(input: any): Record<string, AgentEfSnapshot> {
    if (!input || typeof input !== 'object') return {};
    const out: Record<string, AgentEfSnapshot> = {};
    for (const [key, val] of Object.entries(input)) {
        if (!val || typeof val !== 'object') continue;
        const snap = val as AgentEfSnapshot;
        if (!key) continue;
        out[key] = {
            ...snap,
            AgentKey: snap.AgentKey || key,
            AgentName: snap.AgentName || 'Unknown',
        };
    }
    return out;
}

function normalizeHistoryMap(input: any): Record<string, AgentEfSnapshot[]> {
    if (!input || typeof input !== 'object') return {};
    const out: Record<string, AgentEfSnapshot[]> = {};
    for (const [key, val] of Object.entries(input)) {
        if (!Array.isArray(val)) continue;
        out[key] = val
            .filter(entry => entry && typeof entry === 'object')
            .map(entry => ({
                ...(entry as AgentEfSnapshot),
                AgentKey: (entry as any).AgentKey || key,
                AgentName: (entry as any).AgentName || 'Unknown',
            }));
    }
    return out;
}

function computeAgentEfState(samples: SampleInfo[], prevLatestInput: any, prevHistoryInput: any): AgentEfState {
    const grouped = new Map<string, SampleInfo[]>();
    const agentNameMap: Record<string, string> = {};
    for (const sample of samples || []) {
        const { key, name } = normalizeAgent(sample?.Agent);
        const agentLabel = sample?.Agent && String(sample.Agent).trim() ? String(sample.Agent).trim() : name;
        const current: SampleInfo = {
            ...sample,
            Agent: agentLabel,
            AgentKey: sample?.AgentKey || key,
        };
        agentNameMap[key] = name;
        const arr = grouped.get(key) || [];
        arr.push(current);
        grouped.set(key, arr);
    }
    const prevLatest = normalizeLatestMap(prevLatestInput);
    const prevHistory = normalizeHistoryMap(prevHistoryInput);
    const latestByAgent: Record<string, AgentEfSnapshot> = {};
    const historyByAgent: Record<string, AgentEfSnapshot[]> = {};
    const changedAgentKeys = new Set<string>();
    const removedAgentKeys = new Set<string>();
    let topSnapshot: AgentEfSnapshot | null = null;
    let topAgentKey: string | null = null;

    const allAgentKeys = new Set<string>([...grouped.keys(), ...Object.keys(prevLatest)]);
    for (const agentKey of allAgentKeys) {
        const samplesForAgent = grouped.get(agentKey) || [];
        const mostRecent = getMostRecentSamples(samplesForAgent, 6);
        if (!mostRecent.length) {
            if (prevLatest[agentKey]) {
                changedAgentKeys.add(agentKey);
                removedAgentKeys.add(agentKey);
            }
            continue;
        }
        const twaList = mostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
        const efVal = (twaList.length >= 2) ? calculateExceedanceProbability(twaList, 0.05) : 0;
        const displayName = agentNameMap[agentKey] || prevLatest[agentKey]?.AgentName || 'Unknown';
        const snapshot = createExceedanceFraction(efVal, mostRecent, twaList, { key: agentKey, name: displayName }) as AgentEfSnapshot;
        snapshot.AgentKey = agentKey;
        snapshot.AgentName = displayName;
        const prev = prevLatest[agentKey];
        const prevHistoryForAgent = prevHistory[agentKey] ? [...prevHistory[agentKey]] : [];
        const sameEf = prev ? almostEqual(prev.ExceedanceFraction, snapshot.ExceedanceFraction) : false;
        const sameCount = prev ? (prev.MostRecentNumber || 0) === (snapshot.MostRecentNumber || 0) : false;
        const sameSamples = prev ? deepEqual(compactResults(prev.ResultsUsed), compactResults(snapshot.ResultsUsed)) : false;

        if (prev && sameEf && sameCount && sameSamples) {
            latestByAgent[agentKey] = prev;
            historyByAgent[agentKey] = prevHistoryForAgent.length ? prevHistoryForAgent : (prevHistory[agentKey] || []);
        } else {
            changedAgentKeys.add(agentKey);
            const historyLimited = [...prevHistoryForAgent, snapshot];
            if (historyLimited.length > 50) historyLimited.splice(0, historyLimited.length - 50);
            historyByAgent[agentKey] = historyLimited;
            latestByAgent[agentKey] = snapshot;
        }

        const candidate = latestByAgent[agentKey];
        if (!candidate) continue;
        if (!topSnapshot) {
            topSnapshot = candidate;
            topAgentKey = agentKey;
        } else {
            const betterEf = candidate.ExceedanceFraction > topSnapshot.ExceedanceFraction;
            const sameEfButMoreSamples = almostEqual(candidate.ExceedanceFraction, topSnapshot.ExceedanceFraction) && (candidate.MostRecentNumber || 0) > (topSnapshot.MostRecentNumber || 0);
            if (betterEf || sameEfButMoreSamples) {
                topSnapshot = candidate;
                topAgentKey = agentKey;
            }
        }
    }

    return { latestByAgent, historyByAgent, topSnapshot, topAgentKey, changedAgentKeys, removedAgentKeys };
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

function createExceedanceFraction(exceedanceFraction: number, resultsUsed: SampleInfo[], TWAlist: number[], agent?: AgentNormalization): ExceedanceFraction {
    return {
        ExceedanceFraction: exceedanceFraction,
        DateCalculated: new Date().toISOString(),
        OELNumber: 0.05,
        MostRecentNumber: TWAlist.length,
        ResultsUsed: resultsUsed,
        AgentKey: agent?.key,
        AgentName: agent?.name,
    };
}



// export const recomputeExceedanceFraction = onDocumentWritten("organizations/{orgId}/exposureGroups/{docId}", async (event: any) => {
//     const before = event.data?.before?.data() as any | undefined;
//     const after = event.data?.after?.data() as any | undefined;
//     const docId = event.params.docId as string;
//     const orgId = event.params.orgId as string;
//     if (!after) {
//         logger.info(`EF trigger: document deleted, skipping: organizations/${orgId}/exposureGroups/${docId}`);
//         return;
//     }

//     // If still importing, let results-trigger or batch handle it later
//     if (after?.Importing) {
//         logger.info(`EF trigger: Importing flag set, skipping parent-doc recompute for ${docId}`);
//         return;
//     }

//     // Helper to normalize timestamp-like values to epoch millis
//     const toMillis = (v: any): number => {
//         try {
//             if (!v) return 0;
//             if (typeof v.toMillis === 'function') return v.toMillis();
//             if (v instanceof Date) return v.getTime();
//             if (typeof v === 'string') {
//                 const t = Date.parse(v);
//                 return isNaN(t) ? 0 : t;
//             }
//         } catch { /* noop */ }
//         return 0;
//     };

//     // If bulk import already computed EF in this same write, skip
//     if (after?.EFComputedAt && after?.updatedAt && toMillis(after.EFComputedAt) === toMillis(after.updatedAt)) {
//         logger.info(`EF trigger: precomputed EF detected, skipping for ${docId}`);
//         return;
//     }

//     // Determine if we should recompute:
//     // - EF is missing, OR
//     // - Importing transitioned true -> false, OR
//     // - Legacy path: Results array changed
//     const beforeResultsStr = JSON.stringify(before?.Results || []);
//     const afterResultsStr = JSON.stringify(after.Results || []);
//     const efMissing = !after.LatestExceedanceFraction || !Array.isArray(after.ExceedanceFractionHistory);
//     const importingTransition = !!before?.Importing && !after?.Importing;
//     const resultsChanged = beforeResultsStr !== afterResultsStr;
//     if (!efMissing && !importingTransition && !resultsChanged) {
//         logger.info(`EF trigger: no relevant change, skipping for ${docId}`);
//         return;
//     }

//     const db = getFirestore();
//     const ref = db.doc(`organizations/${orgId}/exposureGroups/${docId}`);

//     // Prefer recompute from parent Results (already present in bulk import) to avoid subcollection reads.
//     const computeFromSubcollection = async (): Promise<{ latest: ExceedanceFraction; mostRecent: SampleInfo[] } | null> => {
//         try {
//             const resultsRef = db.collection(`organizations/${orgId}/exposureGroups/${docId}/results`);
//             const snap = await resultsRef.orderBy('SampleDate', 'desc').limit(12).get();
//             if (snap.empty) return null;
//             const all = snap.docs.map(d => d.data() as any);
//             const candidates = all.filter(r => Number(r?.TWA) > 0);
//             const mostRecent = candidates.slice(0, 6).map(r => ({
//                 SampleDate: r.SampleDate,
//                 ExposureGroup: r.ExposureGroup || r.Group,
//                 TWA: Number(r.TWA),
//                 Notes: r.Notes,
//                 SampleNumber: r.SampleNumber,
//                 Agent: r.Agent,
//             })) as SampleInfo[];
//             const TWAlist = mostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
//             const ef = (TWAlist.length >= 2) ? calculateExceedanceProbability(TWAlist, 0.05) : 0;
//             const latest = createExceedanceFraction(ef, mostRecent, TWAlist);
//             return { latest, mostRecent };
//         } catch (e) {
//             logger.error('computeFromSubcollection failed', { orgId, docId, error: (e as any)?.message || String(e) });
//             return null;
//         }
//     };

//     // Compute total count once here (if available) to avoid per-write increments during Importing
//     let totalCount: number | undefined = undefined;
//     try {
//         const resultsRef = db.collection(`organizations/${orgId}/exposureGroups/${docId}/results`);
//         const countFn = (resultsRef as any).count;
//         if (typeof countFn === 'function') {
//             const aggSnap = await (resultsRef as any).count().get();
//             totalCount = aggSnap?.data()?.count ?? undefined;
//         }
//     } catch (e) {
//         logger.info('Results count not available', { orgId, docId });
//     }

//     await db.runTransaction(async (tx: any) => {
//         const snap = await tx.get(ref);
//         if (!snap.exists) return;
//         const data = snap.data() || {} as any;
//         let latest: ExceedanceFraction;
//         let mostRecent: SampleInfo[];

//         // First try computing from parent Results to avoid subcollection reads.
//         const parentResults: SampleInfo[] = (data.Results || []) as SampleInfo[];
//         mostRecent = getMostRecentSamples(parentResults, 6);
//         if (mostRecent.length >= 2) {
//             const TWAlist = mostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
//             const ef = (TWAlist.length >= 2) ? calculateExceedanceProbability(TWAlist, 0.05) : 0;
//             latest = createExceedanceFraction(ef, mostRecent, TWAlist);
//         } else {
//             // Fallback: compute from subcollection if parent Results insufficient
//             const subResult = await computeFromSubcollection();
//             if (subResult) {
//                 latest = subResult.latest;
//                 mostRecent = subResult.mostRecent;
//             } else {
//                 // No data available; set an empty EF snapshot
//                 mostRecent = [];
//                 latest = createExceedanceFraction(0, mostRecent, []);
//             }
//         }


//         const payload: any = {
//             LatestExceedanceFraction: latest,
//             ResultsPreview: mostRecent, // keep small preview for UI without overwriting bulk Results array
//         };
//         if (typeof totalCount === 'number') payload.ResultsTotalCount = totalCount;
//         tx.set(ref, payload, { merge: true });
//     });

//     logger.info(`Recomputed EF (parent-trigger) for organizations/${orgId}/exposureGroups/${docId}`);
// });

// --- Sync org membership into users/{uid} docs ---
// (Removed membership sync triggers now that create/delete use callables)

// --- Callable: createOrganization ---
export const createOrganization = onCall(async (request) => {
    const uid = request.auth?.uid;
    const { name } = request.data || {};
    if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
    if (!name || typeof name !== 'string' || !name.trim()) {
        throw new HttpsError('invalid-argument', 'Organization name required');
    }
    const db = getFirestore();
    const orgRef = db.collection('organizations').doc();
    const now = Timestamp.now();
    const orgData = {
        Name: name.trim(),
        UserUids: [uid],
        Permissions: { [uid]: { assignPermissions: true } },
        createdAt: now,
        createdBy: uid,
        updatedAt: now,
        updatedBy: uid,
    };
    // Mirror membership to user doc in same batch/transaction
    await db.runTransaction(async (tx: any) => {
        tx.set(orgRef, orgData, { merge: true });
        const userRef = db.doc(`users/${uid}`);
        tx.set(userRef, {
            [`orgMemberships.${orgRef.id}`]: { assignPermissions: true, name: orgData.Name },
            orgIds: FieldValue.arrayUnion(orgRef.id),
            updatedAt: now,
        }, { merge: true });
    });
    return { orgId: orgRef.id, name: orgData.Name };
});

// --- Callable: deleteOrganization ---
export const deleteOrganization = onCall(async (request) => {
    const uid = request.auth?.uid;
    const { orgId } = request.data || {};
    if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
    if (!orgId || typeof orgId !== 'string') throw new HttpsError('invalid-argument', 'orgId required');
    const db = getFirestore();
    const orgRef = db.doc(`organizations/${orgId}`);
    const snap = await orgRef.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Organization not found');
    const data = snap.data() || {} as any;
    // Only members with assignPermissions true can delete
    const can = !!data?.Permissions?.[uid]?.assignPermissions;
    if (!can) throw new HttpsError('permission-denied', 'Not authorized to delete organization');
    const userUids: string[] = (data.UserUids || []).filter((x: any) => typeof x === 'string');
    const writer = (db as any).bulkWriter ? (db as any).bulkWriter() : null;

    // Helpers to recursively delete documents and subcollections
    const deleteDocDeep = async (docRef: FirebaseFirestore.DocumentReference) => {
        try {
            const subcols = await (docRef as any).listCollections();
            for (const col of subcols as FirebaseFirestore.CollectionReference[]) {
                const subSnap = await col.get();
                for (const d of subSnap.docs) {
                    await deleteDocDeep(d.ref);
                }
            }
        } catch (e) {
            logger.warn('deleteDocDeep: listCollections/get failed', { path: docRef.path, error: (e as any)?.message || String(e) });
        }
        if (writer) writer.delete(docRef); else await docRef.delete();
    };
    const deleteCollectionDeep = async (collectionPath: string) => {
        try {
            const colRef = db.collection(collectionPath);
            const snap = await colRef.get();
            if (snap.empty) return;
            for (const doc of snap.docs) {
                await deleteDocDeep(doc.ref);
            }
        } catch (e) {
            logger.warn('deleteCollectionDeep: failed', { collectionPath, error: (e as any)?.message || String(e) });
        }
    };

    // Delete known org-level collections and their nested subcollections
    await deleteCollectionDeep(`organizations/${orgId}/exposureGroups`);
    await deleteCollectionDeep(`organizations/${orgId}/agents`);
    await deleteCollectionDeep(`organizations/${orgId}/importJobs`);

    // Delete organization document last
    if (writer) writer.delete(orgRef); else await orgRef.delete();

    // Remove org membership from users
    for (const memberUid of userUids) {
        const userRef = db.doc(`users/${memberUid}`);
        const payload: any = {
            [`orgMemberships.${orgId}`]: FieldValue.delete(),
            orgIds: FieldValue.arrayRemove(orgId),
            updatedAt: Timestamp.now(),
        };
        if (writer) writer.set(userRef, payload, { merge: true }); else await userRef.set(payload, { merge: true });
    }

    if (writer) await writer.close();
    return { deleted: true, orgId };
});

// --- Callable: renameOrganization ---
export const renameOrganization = onCall(async (request) => {
    const uid = request.auth?.uid;
    const { orgId, newName } = request.data || {};
    if (!uid) throw new HttpsError('unauthenticated', 'Authentication required');
    if (!orgId || typeof orgId !== 'string') throw new HttpsError('invalid-argument', 'orgId required');
    if (!newName || typeof newName !== 'string' || !newName.trim()) {
        throw new HttpsError('invalid-argument', 'New organization name required');
    }
    const db = getFirestore();
    const orgRef = db.doc(`organizations/${orgId}`);
    const snap = await orgRef.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Organization not found');
    const data = snap.data() || {} as any;
    // Only members with assignPermissions true can rename
    const can = !!data?.Permissions?.[uid]?.assignPermissions;
    if (!can) throw new HttpsError('permission-denied', 'Not authorized to rename organization');
    const userUids: string[] = (data.UserUids || []).filter((x: any) => typeof x === 'string');
    const now = Timestamp.now();
    const trimmedName = newName.trim();
    // Update org and all users' membership references in a transaction
    await db.runTransaction(async (tx: any) => {
        tx.update(orgRef, {
            Name: trimmedName,
            updatedAt: now,
            updatedBy: uid,
        });
        for (const memberUid of userUids) {
            const userRef = db.doc(`users/${memberUid}`);
            tx.set(userRef, {
                [`orgMemberships.${orgId}.name`]: trimmedName,
                updatedAt: now,
            }, { merge: true });
        }
    });
    return { orgId, name: trimmedName };
});

// // Maintain a total count of results on the parent doc using subcollection writes
// export const maintainResultsTotalCount = onDocumentWritten("organizations/{orgId}/exposureGroups/{groupId}/results/{resultId}", async (event: any) => {
//     const orgId = event.params.orgId as string;
//     const groupId = event.params.groupId as string;
//     const beforeExists = !!event.data?.before?.exists;
//     const afterExists = !!event.data?.after?.exists;
//     if (beforeExists === afterExists) {
//         // Pure update, no net count change
//         return;
//     }
//     const db = getFirestore();
//     const parentRef = db.doc(`organizations/${orgId}/exposureGroups/${groupId}`);
//     // Skip count increments while Importing is true to avoid excessive parent writes
//     try {
//         const parentSnap = await parentRef.get();
//         const parentData = parentSnap.exists ? (parentSnap.data() || {}) : {};
//         if (parentData?.Importing) {
//             logger.info(`ResultsTotalCount skipped due to Importing for org ${orgId} group ${groupId}`);
//             return;
//         }
//     } catch { /* ignore and proceed */ }
//     const delta = (!beforeExists && afterExists) ? 1 : -1;
//     await parentRef.set({ ResultsTotalCount: FieldValue.increment(delta) }, { merge: true });
//     logger.info(`ResultsTotalCount ${delta > 0 ? '++' : '--'} for org ${orgId} group ${groupId}`);
// });

// Recompute EF when results subcollection changes: read latest 6, compute EF, update parent doc
// export const recomputeEfOnResultsWrite = onDocumentWritten("organizations/{orgId}/exposureGroups/{groupId}/results/{resultId}", async (event: any) => {
//     ...kept commented to avoid per-row recomputes...
// });

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
            const fallback = createExceedanceFraction((fallbackTwa.length >= 2) ? calculateExceedanceProbability(fallbackTwa, 0.05) : 0, fallbackMostRecent as any, fallbackTwa, { key: 'unknown', name: 'Unknown' }) as AgentEfSnapshot;
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

// HTTPS callable: bulk import results using Firestore BulkWriter for speed
export const bulkImportResults = onCall({ timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
    const { orgId, organizationName, groups, trackJob, jobId: providedJobId, importId: providedImportId, finalize, totalGroups: totalGroupsProvided, totalRows: totalRowsProvided } = request.data || {};
    const uid = request.auth?.uid || 'system';
    if (!orgId || !Array.isArray(groups) || groups.length === 0) {
        throw new HttpsError('invalid-argument', 'orgId and groups[] required');
    }
    const db = getFirestore();
    const chosenId = ((): string => {
        const incoming = providedJobId || providedImportId; // support either name from client
        if (incoming && typeof incoming === 'string' && incoming.trim()) return incoming.trim();
        return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    })();
    const jobId = chosenId;
    const jobRef = db.doc(`organizations/${orgId}/importJobs/${jobId}`);

    type IncomingSample = { Location?: string; SampleNumber?: string | number | null; SampleDate?: string; ExposureGroup?: string; Agent?: string; AgentKey?: string; TWA?: number | string | null; Notes?: string };
    type GroupIn = { groupName: string; samples: IncomingSample[] };

    const slugify = (text: string): string => (text || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').replace(/-+/g, '-').slice(0, 120);
    const sanitize = (r: any) => {
        const sampleNumber = r?.SampleNumber;
        const twaRaw = r?.TWA;
        const twa = (twaRaw === '' || twaRaw === undefined || twaRaw === null) ? null : Number(twaRaw);
        const agentRaw = typeof r?.Agent === 'string' ? r.Agent.trim() : '';
        const agentKey = normalizeAgent(agentRaw).key;
        return {
            Location: r?.Location ?? "",
            SampleNumber: (sampleNumber === undefined || sampleNumber === '') ? null : sampleNumber,
            SampleDate: r?.SampleDate ?? "",
            ExposureGroup: r?.ExposureGroup ?? "",
            Agent: agentRaw,
            AgentKey: agentKey,
            TWA: twa,
            Notes: r?.Notes ?? "",
        } as IncomingSample;
    };

    // No pre-existence fetch; rely on transaction snap.exists later to set createdAt/By

    // Initialize job doc on first batch; subsequent batches will just increment counters
    if (trackJob) {
        try {
            const snap = await jobRef.get();
            if (!snap.exists) {
                const totalGroupsAll = typeof totalGroupsProvided === 'number' ? totalGroupsProvided : (groups as GroupIn[]).length;
                const totalRowsAll = typeof totalRowsProvided === 'number' ? totalRowsProvided : (groups as GroupIn[]).reduce((sum, g) => sum + (g.samples?.length || 0), 0);
                await jobRef.set({
                    status: 'running',
                    phase: 'running',
                    totalGroups: totalGroupsAll,
                    totalRows: totalRowsAll,
                    groupsProcessed: 0,
                    rowsWritten: 0,
                    failures: 0,
                    startedAt: Timestamp.now(),
                    updatedAt: Timestamp.now(),
                    createdBy: uid,
                }, { merge: true });
            }
        } catch (e) { logger.warn('bulkImportResults: failed to init job doc', { error: (e as any)?.message || String(e) }); }
    }

    // Merge incoming rows into parent Results array (single write per group)
    // Also accumulate an organization-level EfSummary map to reduce client reads
    // and build per-job undo metadata to support reverting this upload
    let rowsWritten = 0;
    let failuresCount = 0;
    const orgSummaryUpdate: Record<string, any> = {};
    const undoGroups: Record<string, any> = {};
    for (const g of groups as GroupIn[]) {
        const groupId = slugify(g.groupName);
        const parentRef = db.doc(`organizations/${orgId}/exposureGroups/${groupId}`);
        const incoming = (g.samples || []).map(sanitize) as SampleInfo[];
        rowsWritten += incoming.length;
        try {
            const txResult = await db.runTransaction(async (tx: any) => {
                const snap = await tx.get(parentRef);
                const data = snap.exists ? ((snap.data() || {}) as any) : {};
                const existingResults: SampleInfo[] = Array.isArray(data.Results) ? (data.Results as any[]) : [];

                // Normalize rows to a canonical shape with agent metadata
                const normalize = (r: any, isExisting = false) => {
                    const sampleNumberRaw = r?.SampleNumber;
                    const twaRaw = r?.TWA;
                    const twa = (twaRaw === '' || twaRaw === undefined || twaRaw === null) ? null : Number(twaRaw);
                    const agentRaw = typeof r?.Agent === 'string' ? r.Agent.trim() : '';
                    const agentKey = (r?.AgentKey && typeof r.AgentKey === 'string') ? r.AgentKey : normalizeAgent(agentRaw).key;
                    return {
                        Location: r?.Location ?? "",
                        SampleNumber: (sampleNumberRaw === undefined || sampleNumberRaw === '') ? null : sampleNumberRaw,
                        SampleDate: r?.SampleDate ?? "",
                        ExposureGroup: r?.ExposureGroup || r?.Group || g.groupName,
                        Agent: agentRaw,
                        AgentKey: agentKey,
                        TWA: (twa === null || Number.isNaN(twa)) ? null : twa,
                        Notes: r?.Notes ?? "",
                        ImportJobId: isExisting ? (r?.ImportJobId ?? null) : jobId,
                    };
                };

                const existingNorm = (existingResults || []).map(r => normalize(r, true));
                const incomingNorm = (incoming || []).map(r => normalize(r, false));

                const toKeySignatureMap = (arr: any[]) => {
                    const m = new Map<string, { twa: number | null; agentKey: string }>();
                    for (const r of (arr || [])) {
                        const snRaw = (r?.SampleNumber === undefined || r?.SampleNumber === null || r?.SampleNumber === '') ? null : String(r.SampleNumber).trim();
                        if (snRaw == null) continue;
                        const agentKey = r?.AgentKey || normalizeAgent(r?.Agent).key;
                        const twaRaw = (r?.TWA === '' || r?.TWA === undefined || r?.TWA === null) ? null : Number(r.TWA);
                        const twaVal = (twaRaw === null || Number.isNaN(twaRaw)) ? null : twaRaw;
                        m.set(snRaw, { twa: twaVal, agentKey });
                    }
                    return m;
                };

                const mapsEqual = (a: Map<string, { twa: number | null; agentKey: string }>, b: Map<string, { twa: number | null; agentKey: string }>) => {
                    if (a.size !== b.size) return false;
                    for (const [k, v] of a.entries()) {
                        const bv = b.get(k);
                        if (!bv) return false;
                        const twaEqual = (v.twa === null && bv.twa === null) || (v.twa !== null && bv.twa !== null && almostEqual(v.twa, bv.twa));
                        if (!twaEqual) return false;
                        if ((v.agentKey || '') !== (bv.agentKey || '')) return false;
                    }
                    return true;
                };

                const prevMap = toKeySignatureMap(existingNorm);
                const nextMap = toKeySignatureMap(incomingNorm);
                const unchangedKeyTWA = mapsEqual(prevMap, nextMap);

                const changedAgents = new Set<string>();
                const unionKeys = new Set<string>([...prevMap.keys(), ...nextMap.keys()]);
                for (const key of unionKeys) {
                    const before = prevMap.get(key);
                    const after = nextMap.get(key);
                    if (!before && after) {
                        if (after.agentKey) changedAgents.add(after.agentKey);
                        continue;
                    }
                    if (before && !after) {
                        if (before.agentKey) changedAgents.add(before.agentKey);
                        continue;
                    }
                    if (!before || !after) continue;
                    const twaChanged = !((before.twa === null && after.twa === null) || (before.twa !== null && after.twa !== null && almostEqual(before.twa, after.twa)));
                    const agentChanged = (before.agentKey || '') !== (after.agentKey || '');
                    if (twaChanged || agentChanged) {
                        if (before.agentKey) changedAgents.add(before.agentKey);
                        if (after.agentKey) changedAgents.add(after.agentKey);
                    }
                }

                const collectNoKeyAgents = (arr: any[]) => {
                    const set = new Set<string>();
                    for (const r of (arr || [])) {
                        const snRaw = (r?.SampleNumber === undefined || r?.SampleNumber === null || r?.SampleNumber === '') ? null : String(r.SampleNumber).trim();
                        if (snRaw !== null) continue;
                        const agentKey = r?.AgentKey || normalizeAgent(r?.Agent).key;
                        if (agentKey) set.add(agentKey);
                    }
                    return set;
                };
                const noKeyIncomingAgents = collectNoKeyAgents(incomingNorm);
                const noKeyExistingAgents = collectNoKeyAgents(existingNorm);
                for (const agentKey of noKeyIncomingAgents) changedAgents.add(agentKey);
                for (const agentKey of noKeyExistingAgents) changedAgents.add(agentKey);

                // Build map keyed by SampleNumber for replacement, and collect no-key entries separately
                const bySampleNumber = new Map<string, any>();
                const noKey: any[] = [];
                const replaced: Record<string, any> = {};

                for (const r of existingNorm) {
                    const sn = r.SampleNumber;
                    if (sn === null || sn === undefined) {
                        noKey.push(r);
                    } else {
                        bySampleNumber.set(String(sn).trim(), r);
                    }
                }

                for (const r of incomingNorm) {
                    const sn = r.SampleNumber;
                    if (sn === null || sn === undefined) {
                        // No key available; append as a distinct row
                        noKey.push(r);
                    } else {
                        // Replace or add
                        const key = String(sn).trim();
                        const prev = bySampleNumber.get(key);
                        if (prev) {
                            // Track previous row so we can restore on undo
                            replaced[key] = prev;
                        }
                        bySampleNumber.set(key, r);
                    }
                }

                const mergedUnique = [...bySampleNumber.values(), ...noKey];
                const sorted = mergedUnique.sort((a, b) => parseDateToEpoch(b.SampleDate) - parseDateToEpoch(a.SampleDate));
                const limited = sorted.slice(0, 30);
                // Prepare preview regardless; EF may be reused if inputs are unchanged
                const mostRecent = getMostRecentSamples(limited as any, 6);
                const nowTs = Timestamp.now();
                const prevLatestByAgent = normalizeLatestMap(data?.LatestExceedanceFractionByAgent);
                const hasPrevAgentSnapshots = Object.keys(prevLatestByAgent).length > 0;
                const shouldSkipEf = unchangedKeyTWA && hasPrevAgentSnapshots && changedAgents.size === 0;
                if (shouldSkipEf && data?.LatestExceedanceFraction) {
                    // Skip EF recompute/history if inputs unchanged; still update Results & Preview
                    const payload: any = {
                        OrganizationUid: orgId,
                        OrganizationName: organizationName || null,
                        Group: g.groupName,
                        ExposureGroup: g.groupName,
                        Results: limited,
                        ResultsPreview: mostRecent,
                        ResultsTotalCount: limited.length,
                        updatedAt: nowTs,
                        updatedBy: uid,
                    };
                    if (!snap.exists) {
                        payload.createdAt = nowTs;
                        payload.createdBy = uid;
                    }
                    tx.set(parentRef, payload, { merge: true });
                    // No org summary entry necessary; no EF change
                    return { entry: null, patch: { groupId, replaced } };
                } else {
                    const agentEfState = computeAgentEfState(limited as any, data?.LatestExceedanceFractionByAgent, data?.ExceedanceFractionHistoryByAgent);
                    let topSnapshot = agentEfState.topSnapshot;
                    if (!topSnapshot) {
                        const fallbackMostRecent = getMostRecentSamples(limited as any, 6);
                        const fallbackTwa = fallbackMostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
                        const fallback = createExceedanceFraction((fallbackTwa.length >= 2) ? calculateExceedanceProbability(fallbackTwa, 0.05) : 0, fallbackMostRecent as any, fallbackTwa, { key: 'unknown', name: 'Unknown' }) as AgentEfSnapshot;
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
                    const prevEfVal = prevTopCompact?.ExceedanceFraction ?? null;
                    const payload: any = {
                        OrganizationUid: orgId,
                        OrganizationName: organizationName || null,
                        Group: g.groupName,
                        ExposureGroup: g.groupName,
                        Results: limited,
                        ResultsPreview: mostRecent,
                        ResultsTotalCount: limited.length,
                        updatedAt: nowTs,
                        updatedBy: uid,
                        LatestExceedanceFractionByAgent: agentEfState.latestByAgent,
                        ExceedanceFractionHistoryByAgent: agentEfState.historyByAgent,
                    };
                    if (topSnapshot && (topChanged || !data?.LatestExceedanceFraction)) {
                        payload.LatestExceedanceFraction = topSnapshot;
                        payload.ExceedanceFractionHistory = FieldValue.arrayUnion(topSnapshot as any);
                        payload.EFComputedAt = nowTs;
                    }
                    if (!payload.ExceedanceFractionHistory && data?.ExceedanceFractionHistory) {
                        payload.ExceedanceFractionHistory = data.ExceedanceFractionHistory;
                    }
                    if (!snap.exists) {
                        payload.createdAt = nowTs;
                        payload.createdBy = uid;
                    }
                    tx.set(parentRef, payload, { merge: true });
                    // Build summary entry for org-level EfSummary map
                    const entry = topSnapshot ? {
                        GroupId: groupId,
                        ExposureGroup: g.groupName,
                        ExceedanceFraction: topSnapshot.ExceedanceFraction,
                        PreviousExceedanceFraction: prevEfVal,
                        Agent: topSnapshot.AgentName ?? null,
                        AgentKey: topSnapshot.AgentKey ?? null,
                        OELNumber: topSnapshot.OELNumber,
                        DateCalculated: topSnapshot.DateCalculated,
                        SamplesUsedCount: topSnapshot.MostRecentNumber,
                        ByAgent: byAgentSummary,
                    } : null;
                    // Return both entry and undo metadata for this group
                    return { entry, patch: { groupId, replaced } };
                }
            });
            // Stage for a single org doc update after loop
            if (txResult?.entry) {
                orgSummaryUpdate[`EfSummary.${groupId}`] = txResult.entry;
            }
            if (txResult?.patch) {
                undoGroups[groupId] = txResult.patch;
            }
        } catch (e: any) {
            failuresCount += 1;
            logger.error('bulkImportResults merge/write failed', { group: g.groupName, error: e?.message || String(e) });
        }
    }

    // Apply a consolidated org-level EfSummary update (one write per callable invocation)
    try {
        if (Object.keys(orgSummaryUpdate).length > 0) {
            const orgRef = db.doc(`organizations/${orgId}`);
            await orgRef.set(orgSummaryUpdate as any, { merge: true });
        }
    } catch (e: any) {
        logger.warn('bulkImportResults: failed to write EfSummary to organization', { orgId, error: e?.message || String(e) });
    }

    // Persist undo metadata incrementally per group and update counters
    if (trackJob) {
        try {
            const nowTs = Timestamp.now();
            const updates: Record<string, any> = {
                undoAvailable: true,
                'undo.orgId': orgId,
                'undo.jobId': jobId,
                rowsWritten: FieldValue.increment(rowsWritten),
                failures: FieldValue.increment(failuresCount),
                groupsProcessed: FieldValue.increment((groups as GroupIn[]).length),
                updatedAt: nowTs,
            };
            for (const [gid, patch] of Object.entries(undoGroups)) {
                updates[`undo.groups.${gid}`] = patch;
            }
            await jobRef.set(updates, { merge: true });
        } catch (e: any) {
            logger.warn('bulkImportResults: failed to write undo metadata/counters', { orgId, jobId, error: e?.message || String(e) });
        }
        // If this is the last batch, finalize the job status
        if (finalize) {
            try {
                await db.runTransaction(async (tx: any) => {
                    const snap = await tx.get(jobRef);
                    const d = (snap.data() || {}) as any;
                    const failuresAll = Number(d.failures || 0);
                    const status = failuresAll > 0 ? 'completed-with-errors' : 'completed';
                    tx.set(jobRef, { status, phase: 'done', completedAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true });
                });
            } catch (e: any) {
                logger.warn('bulkImportResults: finalize failed', { orgId, jobId, error: e?.message || String(e) });
            }
        }
    }

    return { ok: true, groups: (groups as GroupIn[]).length, rowsWritten, failures: failuresCount, jobId };
});

// Callable: undo a previous bulk import by jobId
export const undoImport = onCall({ timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
    const { orgId, jobId } = request.data || {};
    const uid = request.auth?.uid || 'system';
    const { undo, db, jobRef } = await checkForFailures(orgId, jobId);

    const groupIds = Object.keys(undo.groups || {});
    // Initialize progress so UI can display live updates
    try {
        await jobRef.set({
            undoStatus: 'running',
            undoPhase: 'running',
            undoGroupsTotal: groupIds.length,
            undoGroupsProcessed: 0,
            undoRowsRemoved: 0,
            undoRowsRestored: 0,
            undoFailures: 0,
            undoStartedAt: Timestamp.now(),
            undoUpdatedAt: Timestamp.now(),
        }, { merge: true });
    } catch { /* ignore init errors */ }
    const orgSummaryUpdate: Record<string, any> = {};
    let failures = 0;
    // Batch progress updates to reduce write amplification
    const FLUSH_EVERY = Math.max(10, Math.min(150, Number(process.env.UNDO_PROGRESS_FLUSH_EVERY || 150))); // 10..150, default 150
    let processedBatch = 0;
    let removedBatch = 0;
    let restoredBatch = 0;
    let failuresBatch = 0;
    const flushProgress = async (lastGroupId?: string) => {
        if (processedBatch === 0 && removedBatch === 0 && restoredBatch === 0 && failuresBatch === 0) return;
        try {
            await jobRef.set({
                undoGroupsProcessed: FieldValue.increment(processedBatch),
                undoRowsRemoved: FieldValue.increment(removedBatch),
                undoRowsRestored: FieldValue.increment(restoredBatch),
                undoFailures: FieldValue.increment(failuresBatch),
                lastGroupId: lastGroupId || null,
                undoUpdatedAt: Timestamp.now(),
            }, { merge: true });
        } catch (e) {
            logger.warn('undoImport: progress flush failed', { orgId, jobId, processedBatch, error: (e as any)?.message || String(e) });
        } finally {
            processedBatch = 0;
            removedBatch = 0;
            restoredBatch = 0;
            failuresBatch = 0;
        }
    };

    for (let i = 0; i < groupIds.length; i++) {
        const groupId = groupIds[i];
        try {
            const stats = await checkGroupIfItShouldBeUpdated(db, orgId, groupId, undo, jobId, uid, orgSummaryUpdate);
            // Accumulate batch counters for this group
            processedBatch += 1;
            removedBatch += (stats.removedCount || 0);
            restoredBatch += (stats.restoredCount || 0);
            if ((processedBatch % FLUSH_EVERY) === 0) {
                await flushProgress(groupId);
            }
        } catch (e: any) {
            failures += 1;
            logger.error('undoImport: failed group', { groupId, error: e?.message || String(e) });
            failuresBatch += 1;
            processedBatch += 1; // count failed group as processed for progress
            if ((processedBatch % FLUSH_EVERY) === 0) {
                await flushProgress(groupId);
            }
        }
    }
    // Final flush for any remaining counters
    await flushProgress(groupIds[groupIds.length - 1]);
    // Update org summary once
    try {
        if (Object.keys(orgSummaryUpdate).length > 0) {
            const orgRef = db.doc(`organizations/${orgId}`);
            await orgRef.set(orgSummaryUpdate as any, { merge: true });
        }
    } catch (e: any) {
        logger.warn('undoImport: failed to update org summary', { orgId, error: e?.message || String(e) });
    }
    // Mark job as undone
    try {
        const status = failures > 0 ? 'completed-with-errors' : 'completed';
        await jobRef.set({
            undoneAt: Timestamp.now(),
            undoneBy: uid,
            undoStatus: status,
            undoPhase: 'done',
            undoCompletedAt: Timestamp.now(),
            undoUpdatedAt: Timestamp.now(),
        }, { merge: true });
    } catch { }
    return { ok: failures === 0, failures, revertedGroups: groupIds.length };
});


async function checkGroupIfItShouldBeUpdated(db: admin.firestore.Firestore, orgId: any, groupId: string, undo: any, jobId: any, uid: string, orgSummaryUpdate: Record<string, any>): Promise<{ removedCount: number, restoredCount: number, emptied: boolean }> {
    const parentRef = db.doc(`organizations/${orgId}/exposureGroups/${groupId}`);
    let result = { removedCount: 0, restoredCount: 0, emptied: false };
    await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(parentRef);
        if (!snap.exists) return;
        result = undoImportsAndRespectExisting(snap, undo, groupId, jobId, uid, tx, parentRef, orgSummaryUpdate);
    });
    return result;
}

function undoImportsAndRespectExisting(
    snap: any,
    undo: any,
    groupId: string,
    jobId: any,
    uid: string,
    tx: any,
    parentRef: admin.firestore.DocumentReference<admin.firestore.DocumentData, admin.firestore.DocumentData>,
    orgSummaryUpdate: Record<string, any>,
): { removedCount: number, restoredCount: number, emptied: boolean } {
    const data = (snap.data() || {}) as any;
    const eGResults: any[] = Array.isArray(data.Results) ? (data.Results as any[]) : [];
    const replacedMap: Record<string, any> = (undo.groups[groupId]?.replaced || {});
    // Remove rows from this job and restore replaced ones
    const keep: any[] = [];
    const seenKeys = new Set<string>();
    let removedCount = 0;
    findExistingResults(eGResults, (result: any) => {
        return (result?.SampleNumber === undefined || result?.SampleNumber === null || result?.SampleNumber === '') ? null : String(result.SampleNumber).trim();
    }, jobId, replacedMap, keep, seenKeys, (dropped: boolean) => { if (dropped) removedCount += 1; });
    // Restore replaced rows
    let restoredCount = 0;
    for (const [k, prev] of Object.entries(replacedMap)) {
        if (!seenKeys.has(k)) { keep.push(prev); restoredCount += 1; }
    }
    // Sort and limit
    const sorted = keep
        .map((r: any) => ({
            Location: r?.Location ?? "",
            SampleNumber: (r?.SampleNumber === undefined || r?.SampleNumber === '') ? null : r?.SampleNumber,
            SampleDate: r?.SampleDate ?? "",
            ExposureGroup: r?.ExposureGroup || r?.Group || data?.Group || data?.ExposureGroup || groupId,
            Agent: r?.Agent ?? "",
            AgentKey: r?.AgentKey || normalizeAgent(r?.Agent).key,
            TWA: (r?.TWA === '' || r?.TWA === undefined || r?.TWA === null) ? null : Number(r?.TWA),
            Notes: r?.Notes ?? "",
            ImportJobId: r?.ImportJobId ?? null,
        }))
        .sort((a, b) => parseDateToEpoch(b.SampleDate) - parseDateToEpoch(a.SampleDate))
        .slice(0, 30);

    // If no results remain after undo, delete the group and clear org summary
    if (sorted.length === 0) {
        tx.delete(parentRef);
        orgSummaryUpdate[`EfSummary.${groupId}`] = FieldValue.delete();
        return { removedCount, restoredCount, emptied: true };
    }

    const mostRecent = getMostRecentSamples(sorted as any, 6);
    const agentEfState = computeAgentEfState(sorted as any, data?.LatestExceedanceFractionByAgent, data?.ExceedanceFractionHistoryByAgent);
    let topSnapshot = agentEfState.topSnapshot;
    if (!topSnapshot) {
        const fallbackTwa = mostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
        const fallback = createExceedanceFraction((fallbackTwa.length >= 2) ? calculateExceedanceProbability(fallbackTwa, 0.05) : 0, mostRecent as any, fallbackTwa, { key: 'unknown', name: 'Unknown' }) as AgentEfSnapshot;
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
        Results: sorted,
        ResultsPreview: mostRecent,
        ResultsTotalCount: sorted.length,
        LatestExceedanceFractionByAgent: agentEfState.latestByAgent,
        ExceedanceFractionHistoryByAgent: agentEfState.historyByAgent,
        updatedAt: nowTs,
        updatedBy: uid,
    };
    if (topSnapshot && (topChanged || !data?.LatestExceedanceFraction)) {
        payload.LatestExceedanceFraction = topSnapshot;
        payload.ExceedanceFractionHistory = FieldValue.arrayUnion(topSnapshot as any);
        payload.EFComputedAt = nowTs;
    }
    tx.set(parentRef, payload, { merge: true });
    const summaryEntry = topSnapshot ? {
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
    if (summaryEntry) {
        orgSummaryUpdate[`EfSummary.${groupId}`] = summaryEntry;
    } else {
        orgSummaryUpdate[`EfSummary.${groupId}`] = FieldValue.delete();
    }

    return { removedCount, restoredCount, emptied: false };
}

function findExistingResults(
    eGResults: any[],
    getSampleNumberAsString: (result: any) => string | null,
    jobId: any,
    replacedMap: Record<string, any>,
    keep: any[],
    seenKeys: Set<string>,
    onDrop?: (dropped: boolean) => void,
) {
    for (const result of eGResults) {
        const key = getSampleNumberAsString(result);
        const isFromJob = result?.ImportJobId === jobId;
        if (isFromJob) {
            // drop it
            if (onDrop) onDrop(true);
            continue;
        }
        if (key && replacedMap[key]) {
            // Will let restored version replace it after loop
            continue;
        }
        keep.push(result);
        if (key) seenKeys.add(key);
        if (onDrop) onDrop(false);
    }
}

async function checkForFailures(orgId: any, jobId: any) {
    if (!orgId || !jobId) throw new HttpsError('invalid-argument', 'orgId and jobId required');
    const db = getFirestore();
    const jobRef = db.doc(`organizations/${orgId}/importJobs/${jobId}`);
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) throw new HttpsError('not-found', 'job not found');
    const job = jobSnap.data() as any;
    let undo = job?.undo;
    // If no undo metadata exists (older imports), derive a fallback by scanning exposureGroups for rows with this ImportJobId
    if (!undo || !undo.groups) {
        const groupsCol = db.collection(`organizations/${orgId}/exposureGroups`);
        const snap = await groupsCol.select('Results', 'Group', 'ExposureGroup').get();
        const groups: Record<string, any> = {};
        snap.forEach(doc => {
            const d = (doc.data() || {}) as any;
            const results: any[] = Array.isArray(d.Results) ? d.Results : [];
            const hasTagged = results.some(r => r && r.ImportJobId === jobId);
            if (hasTagged) {
                groups[doc.id] = { replaced: {} };
            }
        });

        if (Object.keys(groups).length === 0) {
            throw new HttpsError('failed-precondition', 'No undo metadata available');
        }
        undo = { orgId, jobId, groups };
        // Persist fallback undo metadata for subsequent attempts and UI
        try {
            const updates: Record<string, any> = { undoAvailable: true, 'undo.orgId': orgId, 'undo.jobId': jobId };
            for (const gid of Object.keys(groups)) {
                updates[`undo.groups.${gid}`] = groups[gid];
            }
            updates.updatedAt = Timestamp.now();
            await jobRef.set(updates, { merge: true });
        } catch { /* ignore errors while persisting fallback */ }
    }
    return { undo, db, jobRef };
}
// // --- Audit logs (write-once by Functions) ---
// type AuditLog = {
//     // ISO timestamp when the edit occurred (server time)
//     at: string;
//     actorUid?: string;
//     editedBy?: string;
//     action: 'create' | 'update' | 'delete';
//     documentPath: string;
//     collection: string;
//     docId: string;
//     diff?: any;
//     source?: string;
//     batchId?: string;
//     expireAt?: admin.firestore.Timestamp;
// };

// function computeDiff(before: any, after: any) {
//     // If entire object created or deleted, show full added object or a removedAll flag
//     if (!before && after) return { added: after };
//     if (before && !after) return { removedAll: true };

//     const isPlainObject = (val: any) => val !== null && typeof val === 'object' && !Array.isArray(val);

//     function summarizeValue(v: any) {
//         if (Array.isArray(v)) {
//             return {
//                 _type: "array",
//                 latest: v.slice(0, Math.min(1, v.length)),
//             };
//         }
//         return v;
//     }

//     function diffArrays(bArr: any[], aArr: any[]) {
//         try {
//             const same = JSON.stringify(bArr) === JSON.stringify(aArr);
//             if (same) return null;
//         } catch { /* ignore stringify errors */ }
//         return {
//             _type: 'array',
//             beforeLength: Array.isArray(bArr) ? bArr.length : undefined,
//             afterLength: Array.isArray(aArr) ? aArr.length : undefined,
//             latestBefore: Array.isArray(bArr) ? bArr.slice(0, Math.min(1, bArr.length)) : undefined,
//             latestAfter: Array.isArray(aArr) ? aArr.slice(0, Math.min(1, aArr.length)) : undefined,
//         };
//     }

//     function diffValues(bv: any, av: any): any | null {
//         if (bv === undefined && av !== undefined) return { added: summarizeValue(av) };
//         if (bv !== undefined && av === undefined) return { removed: summarizeValue(bv) };
//         if (isPlainObject(bv) && isPlainObject(av)) return diffObjects(bv, av);
//         if (Array.isArray(bv) && Array.isArray(av)) return diffArrays(bv, av);
//         const same = ((): boolean => {
//             try { return JSON.stringify(bv) === JSON.stringify(av); } catch { return bv === av; }
//         })();
//         if (same) return null;
//         return { before: summarizeValue(bv), after: summarizeValue(av) };
//     }

//     function diffObjects(bObj: Record<string, any>, aObj: Record<string, any>) {
//         const changed: any = {};
//         const added: Record<string, any> = {};
//         const removed: Record<string, any> = {};
//         const keys = new Set([...Object.keys(bObj || {}), ...Object.keys(aObj || {})]);
//         for (const k of keys) {
//             const hasB = Object.prototype.hasOwnProperty.call(bObj || {}, k);
//             const hasA = Object.prototype.hasOwnProperty.call(aObj || {}, k);
//             if (!hasB && hasA) { added[k] = summarizeValue(aObj[k]); continue; }
//             if (hasB && !hasA) { removed[k] = summarizeValue(bObj[k]); continue; }
//             const child = diffValues(bObj[k], aObj[k]);
//             if (child) changed[k] = child;
//         }
//         return { changed, added, removed };
//     }

//     return diffObjects(before || {}, after || {});
// }

// const RETENTION_DAYS = parseInt(process.env.AUDIT_TTL_DAYS || '365', 10) * 2;

// async function writeAudit(orgId: string, collection: string, docId: string, before: any, after: any) {
//     return true;
//     const db = getFirestore();
//     const path = `organizations/${orgId}/${collection}/${docId}`;
//     const action: 'create' | 'update' | 'delete' = !before && after ? 'create' : before && !after ? 'delete' : 'update';
//     const actorUid = after?.updatedBy || before?.updatedBy || undefined;
//     const expireAt = Timestamp.fromDate(new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000));
//     const nowIso = new Date().toISOString();
//     const diff = computeDiff(before, after);

//     const log: AuditLog = {
//         at: nowIso,
//         actorUid,
//         editedBy: actorUid,
//         action,
//         documentPath: path,
//         collection,
//         docId,
//         diff,
//         source: 'function',
//         expireAt,
//     };

//     try {
//         const ref = await db.collection(`organizations/${orgId}/auditLogs`).add(log as any);
//         logger.info('Audit log written', { orgId, collection, docId, logId: ref.id, action });
//         return ref.id as string;
//     } catch (err: any) {
//         logger.error('Failed to write audit log', {
//             orgId,
//             collection,
//             docId,
//             action,
//             error: err?.message || String(err),
//             stack: err?.stack,
//         });
//         throw err;
//     }
// }

// export const auditExposureGroups = onDocumentWritten("organizations/{orgId}/exposureGroups/{docId}", async (event: any) => {

//     return true;
//     const orgId = event.params.orgId as string;
//     const docId = event.params.docId as string;
//     const beforeExists = !!event.data?.before?.exists;
//     const afterExists = !!event.data?.after?.exists;
//     const before = event.data?.before?.data() as any | undefined;
//     const after = event.data?.after?.data() as any | undefined;

//     logger.info('auditExposureGroups fired', {
//         orgId,
//         docId,
//         beforeExists,
//         afterExists,
//         FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || 'not-set',
//     });

//     try {
//         const logId = await writeAudit(orgId, 'exposureGroups', docId, before, after);
//         logger.info('auditExposureGroups success', { orgId, docId, logId });
//     } catch (err: any) {
//         logger.error('auditExposureGroups error', { orgId, docId, error: err?.message || String(err) });
//         // Rethrow to surface in emulator logs as failed invocation
//         throw err;
//     }
// });

// export const auditAgents = onDocumentWritten("organizations/{orgId}/agents/{docId}", async (event: any) => {
//     const orgId = event.params.orgId as string;
//     const docId = event.params.docId as string;
//     const beforeExists = !!event.data?.before?.exists;
//     const afterExists = !!event.data?.after?.exists;
//     const before = event.data?.before?.data() as any | undefined;
//     const after = event.data?.after?.data() as any | undefined;

//     logger.info('auditAgents fired', {
//         orgId,
//         docId,
//         beforeExists,
//         afterExists,
//         FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || 'not-set',
//     });

//     try {
//         const logId = await writeAudit(orgId, 'agents', docId, before, after);
//         logger.info('auditAgents success', { orgId, docId, logId });
//     } catch (err: any) {
//         logger.error('auditAgents error', { orgId, docId, error: err?.message || String(err) });
//         throw err;
//     }
// });
