/**
 * Import function triggers from their respective submodules:
    const jobRef = db.doc(`organizations/${orgId}/importJobs/${jobId}`);
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { onDocumentWritten } from "firebase-functions/v2/firestore";
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
    const orgId = event.params.orgId as string;
    if (!after) {
        logger.info(`EF trigger: document deleted, skipping: organizations/${orgId}/exposureGroups/${docId}`);
        return;
    }

    // If still importing, let results-trigger or batch handle it later
    if (after?.Importing) {
        logger.info(`EF trigger: Importing flag set, skipping parent-doc recompute for ${docId}`);
        return;
    }

    // Helper to normalize timestamp-like values to epoch millis
    const toMillis = (v: any): number => {
        try {
            if (!v) return 0;
            if (typeof v.toMillis === 'function') return v.toMillis();
            if (v instanceof Date) return v.getTime();
            if (typeof v === 'string') {
                const t = Date.parse(v);
                return isNaN(t) ? 0 : t;
            }
        } catch { /* noop */ }
        return 0;
    };

    // If bulk import already computed EF in this same write, skip
    if (after?.EFComputedAt && after?.updatedAt && toMillis(after.EFComputedAt) === toMillis(after.updatedAt)) {
        logger.info(`EF trigger: precomputed EF detected, skipping for ${docId}`);
        return;
    }

    // Determine if we should recompute:
    // - EF is missing, OR
    // - Importing transitioned true -> false, OR
    // - Legacy path: Results array changed
    const beforeResultsStr = JSON.stringify(before?.Results || []);
    const afterResultsStr = JSON.stringify(after.Results || []);
    const efMissing = !after.LatestExceedanceFraction || !Array.isArray(after.ExceedanceFractionHistory);
    const importingTransition = !!before?.Importing && !after?.Importing;
    const resultsChanged = beforeResultsStr !== afterResultsStr;
    if (!efMissing && !importingTransition && !resultsChanged) {
        logger.info(`EF trigger: no relevant change, skipping for ${docId}`);
        return;
    }

    const db = getFirestore();
    const ref = db.doc(`organizations/${orgId}/exposureGroups/${docId}`);

    // Prefer recompute from parent Results (already present in bulk import) to avoid subcollection reads.
    const computeFromSubcollection = async (): Promise<{ latest: ExceedanceFraction; mostRecent: SampleInfo[] } | null> => {
        try {
            const resultsRef = db.collection(`organizations/${orgId}/exposureGroups/${docId}/results`);
            const snap = await resultsRef.orderBy('SampleDate', 'desc').limit(12).get();
            if (snap.empty) return null;
            const all = snap.docs.map(d => d.data() as any);
            const candidates = all.filter(r => Number(r?.TWA) > 0);
            const mostRecent = candidates.slice(0, 6).map(r => ({
                SampleDate: r.SampleDate,
                ExposureGroup: r.ExposureGroup || r.Group,
                TWA: Number(r.TWA),
                Notes: r.Notes,
                SampleNumber: r.SampleNumber,
                Agent: r.Agent,
            })) as SampleInfo[];
            const TWAlist = mostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
            const ef = (TWAlist.length >= 2) ? calculateExceedanceProbability(TWAlist, 0.05) : 0;
            const latest = createExceedanceFraction(ef, mostRecent, TWAlist);
            return { latest, mostRecent };
        } catch (e) {
            logger.error('computeFromSubcollection failed', { orgId, docId, error: (e as any)?.message || String(e) });
            return null;
        }
    };

    // Compute total count once here (if available) to avoid per-write increments during Importing
    let totalCount: number | undefined = undefined;
    try {
        const resultsRef = db.collection(`organizations/${orgId}/exposureGroups/${docId}/results`);
        const countFn = (resultsRef as any).count;
        if (typeof countFn === 'function') {
            const aggSnap = await (resultsRef as any).count().get();
            totalCount = aggSnap?.data()?.count ?? undefined;
        }
    } catch (e) {
        logger.info('Results count not available', { orgId, docId });
    }

    await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const data = snap.data() || {} as any;
        let latest: ExceedanceFraction;
        let mostRecent: SampleInfo[];

        // First try computing from parent Results to avoid subcollection reads.
        const parentResults: SampleInfo[] = (data.Results || []) as SampleInfo[];
        mostRecent = getMostRecentSamples(parentResults, 6);
        if (mostRecent.length >= 2) {
            const TWAlist = mostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
            const ef = (TWAlist.length >= 2) ? calculateExceedanceProbability(TWAlist, 0.05) : 0;
            latest = createExceedanceFraction(ef, mostRecent, TWAlist);
        } else {
            // Fallback: compute from subcollection if parent Results insufficient
            const subResult = await computeFromSubcollection();
            if (subResult) {
                latest = subResult.latest;
                mostRecent = subResult.mostRecent;
            } else {
                // No data available; set an empty EF snapshot
                mostRecent = [];
                latest = createExceedanceFraction(0, mostRecent, []);
            }
        }

        const history: ExceedanceFraction[] = Array.isArray(data.ExceedanceFractionHistory) ? data.ExceedanceFractionHistory : [];
        const updatedHistory = [...history, latest];

        const payload: any = {
            LatestExceedanceFraction: latest,
            ExceedanceFractionHistory: updatedHistory,
            ResultsPreview: mostRecent, // keep small preview for UI without overwriting bulk Results array
        };
        if (typeof totalCount === 'number') payload.ResultsTotalCount = totalCount;
        tx.set(ref, payload, { merge: true });
    });

    logger.info(`Recomputed EF (parent-trigger) for organizations/${orgId}/exposureGroups/${docId}`);
});

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
    const doOne = async (groupId: string) => {
        const parentRef = db.doc(`organizations/${orgId}/exposureGroups/${groupId}`);
        const snap = await parentRef.get();
        if (!snap.exists) return;
        const data = snap.data() || {} as any;
        const parentResults: SampleInfo[] = Array.isArray(data.Results) ? data.Results as any : [];
        const mostRecent = getMostRecentSamples(parentResults, 6);
        const TWAlist = mostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
        const ef = (TWAlist.length >= 2) ? calculateExceedanceProbability(TWAlist, 0.05) : 0;
        const latest = createExceedanceFraction(ef, mostRecent, TWAlist);
        await parentRef.set({
            LatestExceedanceFraction: latest,
            ExceedanceFractionHistory: FieldValue.arrayUnion(latest as any),
            ResultsPreview: mostRecent,
            Importing: false,
            updatedAt: Timestamp.now(),
        }, { merge: true });
    };
    // Limit concurrency to avoid hot shards
    const pool = 10;
    const queue = [...groupIds];
    const workers: Promise<any>[] = new Array(Math.min(pool, queue.length)).fill(0).map(async () => {
        while (queue.length) {
            const id = queue.shift();
            if (!id) break;
            try { await doOne(id); } catch (e) { logger.error('recomputeEfBatch item failed', { id, error: (e as any)?.message || String(e) }); }
        }
    });
    await Promise.all(workers);
    return { ok: true, count: groupIds.length };
});

// HTTPS callable: bulk import results using Firestore BulkWriter for speed
export const bulkImportResults = onCall({ timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
    const { orgId, organizationName, groups, trackJob } = request.data || {};
    const uid = request.auth?.uid || 'system';
    if (!orgId || !Array.isArray(groups) || groups.length === 0) {
        throw new HttpsError('invalid-argument', 'orgId and groups[] required');
    }
    const db = getFirestore();
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const jobRef = db.doc(`organizations/${orgId}/importJobs/${jobId}`);

    type IncomingSample = { Location?: string; SampleNumber?: string | number | null; SampleDate?: string; ExposureGroup?: string; Agent?: string; TWA?: number | string | null; Notes?: string };
    type GroupIn = { groupName: string; samples: IncomingSample[] };

    const slugify = (text: string): string => (text || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').replace(/-+/g, '-').slice(0, 120);
    const sanitize = (r: any) => {
        const sampleNumber = r?.SampleNumber;
        const twaRaw = r?.TWA;
        const twa = (twaRaw === '' || twaRaw === undefined || twaRaw === null) ? null : Number(twaRaw);
        return {
            Location: r?.Location ?? "",
            SampleNumber: (sampleNumber === undefined || sampleNumber === '') ? null : sampleNumber,
            SampleDate: r?.SampleDate ?? "",
            ExposureGroup: r?.ExposureGroup ?? "",
            Agent: r?.Agent ?? "",
            TWA: twa,
            Notes: r?.Notes ?? "",
        } as IncomingSample;
    };

    // No pre-existence fetch; rely on transaction snap.exists later to set createdAt/By

    // Initialize job doc (optional)
    if (trackJob) {
        try {
            const totalRows = (groups as GroupIn[]).reduce((sum, g) => sum + (g.samples?.length || 0), 0);
            await jobRef.set({
                status: 'running',
                phase: 'initializing',
                totalGroups: (groups as GroupIn[]).length,
                totalRows,
                groupsProcessed: 0,
                rowsWritten: 0,
                startedAt: Timestamp.now(),
                updatedAt: Timestamp.now(),
                createdBy: uid,
            }, { merge: true });
        } catch (e) { logger.warn('bulkImportResults: failed to init job doc', { error: (e as any)?.message || String(e) }); }
    }

    // Merge incoming rows into parent Results array (single write per group)
    let rowsWritten = 0;
    let failuresCount = 0;
    for (const g of groups as GroupIn[]) {
        const groupId = slugify(g.groupName);
        const parentRef = db.doc(`organizations/${orgId}/exposureGroups/${groupId}`);
        const incoming = (g.samples || []).map(sanitize) as SampleInfo[];
        rowsWritten += incoming.length;
        try {
            await db.runTransaction(async (tx: any) => {
                const snap = await tx.get(parentRef);
                const data = snap.exists ? ((snap.data() || {}) as any) : {};
                const existingResults: SampleInfo[] = Array.isArray(data.Results) ? (data.Results as any[]) : [];
                const merged = [...existingResults, ...incoming];
                const sorted = merged
                    .map((r: any) => ({
                        Location: r?.Location ?? "",
                        SampleNumber: (r?.SampleNumber === undefined || r?.SampleNumber === '') ? null : r?.SampleNumber,
                        SampleDate: r?.SampleDate ?? "",
                        ExposureGroup: r?.ExposureGroup || r?.Group || g.groupName,
                        Agent: r?.Agent ?? "",
                        TWA: (r?.TWA === '' || r?.TWA === undefined || r?.TWA === null) ? null : Number(r?.TWA),
                        Notes: r?.Notes ?? "",
                    }))
                    .sort((a, b) => parseDateToEpoch(b.SampleDate) - parseDateToEpoch(a.SampleDate));
                const limited = sorted.slice(0, 30);
                // Compute EF from most recent TWA>0 within limited
                const mostRecent = getMostRecentSamples(limited as any, 6);
                const TWAlist = mostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
                const efVal = (TWAlist.length >= 2) ? calculateExceedanceProbability(TWAlist, 0.05) : 0;
                const latestEf = createExceedanceFraction(efVal, mostRecent as any, TWAlist);
                const nowTs = Timestamp.now();
                const payload: any = {
                    OrganizationUid: orgId,
                    OrganizationName: organizationName || null,
                    Group: g.groupName,
                    ExposureGroup: g.groupName,
                    Results: limited,
                    ResultsPreview: mostRecent,
                    ResultsTotalCount: limited.length,
                    LatestExceedanceFraction: latestEf,
                    ExceedanceFractionHistory: FieldValue.arrayUnion(latestEf as any),
                    EFComputedAt: nowTs,
                    updatedAt: nowTs,
                    updatedBy: uid,
                };
                if (!snap.exists) {
                    payload.createdAt = nowTs;
                    payload.createdBy = uid;
                }
                tx.set(parentRef, payload, { merge: true });
            });
        } catch (e: any) {
            failuresCount += 1;
            logger.error('bulkImportResults merge/write failed', { group: g.groupName, error: e?.message || String(e) });
        }
    }

    if (trackJob) {
        try { await jobRef.set({ status: failuresCount > 0 ? 'completed-with-errors' : 'completed', phase: 'done', rowsWritten, failures: failuresCount, groupsProcessed: (groups as GroupIn[]).length, completedAt: Timestamp.now(), updatedAt: Timestamp.now() }, { merge: true }); } catch { }
    }
    return { ok: true, groups: (groups as GroupIn[]).length, rowsWritten, failures: failuresCount, jobId: jobId };
});

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
