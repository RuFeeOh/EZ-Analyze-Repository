import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { loadAgents, slugifyAgent } from "./agent";
import { SampleInfo } from "../models/sample-info.model";
import { AgentEfSnapshot } from "../models/agent-ef-snapshot.model";
import { AgentNormalization } from "../models/agent-normalization.model";
import { AuditLogRecord } from "../models/audit-log-record.model";
import { AgentEfState } from "../models/agent-ef-state.model";
import * as admin from "firebase-admin";
import { Agent } from "../models/agent.model";
import { createExceedanceFraction, calculateExceedanceProbability } from "./ef";
import { IncomingSampleInfo } from "../models/incoming-sample-info.model";
import { slugify } from "./common";
import { compactResults, getRowKeyVariants, normalizeResults, toKeySignatureMap } from "./results";
import { SampleGroupIn } from "../models/sample-group-in.model";
import { ImportSampleInfo } from "../models/import-sample-info.model";
import { finalizeJobStatus, startJobTracking } from "./job-tracking";
import { appendAuditRecords, compactLatestMapForAudit } from "./audit";
import { calculate95thPercentile, calculateAIHARating } from "./aiha-rating";
import { PlantJobExtractor } from "./plant-job-extraction";


/**
 * Load existing exposure group names for an organization to build plant dictionary
 */
async function loadExistingExposureGroupNames(db: admin.firestore.Firestore, orgId: string): Promise<string[]> {
    try {
        const snapshot = await db.collection(`organizations/${orgId}/exposureGroups`)
            .select('ExposureGroup', 'Group')
            .limit(500)
            .get();
        
        const names: string[] = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            const name = data?.ExposureGroup || data?.Group;
            if (name && typeof name === 'string') {
                names.push(name);
            }
        });
        
        return names;
    } catch (e) {
        logger.warn('loadExistingExposureGroupNames: failed to load', { orgId, error: (e as any)?.message || String(e) });
        return [];
    }
}

const timeoutMinute = 4;
const timeoutSeconds = timeoutMinute * 60;
// HTTPS callable: bulk import results using Firestore BulkWriter for speed
export const bulkImportResults = onCall({ timeoutSeconds: timeoutSeconds, memory: '1GiB' }, async (request) => {
    const {
        orgId,
        organizationName,
        groups,
        trackJob,
        jobId: providedJobId,
        importId: providedImportId,
        finalize,
        totalGroups: totalGroupsProvided,
        totalRows: totalRowsProvided
    } = request.data || {};

    const agentsList: Agent[] = await loadAgents(orgId);

    const uid = request.auth?.uid || 'system';
    if (!orgId || !Array.isArray(groups) || groups.length === 0) {
        throw new HttpsError('invalid-argument', 'orgId and groups[] required');
    }
    const db = getFirestore();
    const jobId = getIdForJob(providedJobId, providedImportId);
    const jobRef = db.doc(`organizations/${orgId}/importJobs/${jobId}`);
    
    // Load existing exposure groups for plant dictionary
    const existingGroups = await loadExistingExposureGroupNames(db, orgId);
    const plantJobExtractor = new PlantJobExtractor(existingGroups);

    // Initialize job doc on first batch; subsequent batches will just increment counters
    if (trackJob) {
        await startJobTracking(jobRef, totalGroupsProvided, groups, totalRowsProvided, uid);
    }

    let orgSummaryUpdate: Record<string, any> = {};
    const jobStatus = new importJobStatus({
        db: db,
        uid: uid,
        jobRef: jobRef,
        orgId: orgId,
        jobId: jobId,
        rowsWritten: 0,
        failuresCount: 0,
        undoGroups: {},
        auditEntries: [],
        groupsProcessed: (groups as SampleGroupIn[]).length,
        orgSummaryUpdate: {}
    });
    for (const g of groups as SampleGroupIn[]) {
        await processIncomingSamples(
            g,
            agentsList,
            organizationName,
            jobStatus,
            plantJobExtractor
        );
    }

    // Apply a consolidated org-level EfSummary update (one write per callable invocation)
    await updateOrganizationWithExposureGroupSummary(orgSummaryUpdate, db, orgId);

    // Persist undo metadata incrementally per group and update counters
    if (trackJob) {
        await updateUndoMetadata(jobStatus);
        // If this is the last batch, finalize the job status
        if (finalize) {
            await finalizeJobStatus(db, jobRef, orgId, jobId);
        }
    }

    if (jobStatus.auditEntries.length) {
        await appendAuditRecords(orgId, jobStatus.auditEntries);
    }
    return {
        ok: true,
        groups: (groups as SampleGroupIn[]).length,
        rowsWritten: jobStatus.rowsWritten,
        failures: jobStatus.failuresCount,
        jobId: jobStatus.jobId
    };
});

class importJobStatus {
    db!: admin.firestore.Firestore | null;
    uid!: string;
    jobRef!: admin.firestore.DocumentReference<admin.firestore.DocumentData, admin.firestore.DocumentData> | null;
    orgId!: string;
    jobId!: string;
    rowsWritten!: number;
    undoGroups!: Record<string, any>;
    failures!: number;
    groupsProcessed!: number;
    auditEntries!: AuditLogRecord[];
    failuresCount!: number;
    orgSummaryUpdate!: Record<string, any>;
    constructor(init?: Partial<importJobStatus>) {
        Object.assign(this, init);
    }
}




async function updateUndoMetadata(jobStatus: importJobStatus) {
    try {
        const nowTs = Timestamp.now();
        const updates: Record<string, any> = {
            undoAvailable: true,
            'undo.orgId': jobStatus.orgId,
            'undo.jobId': jobStatus.jobId,
            rowsWritten: FieldValue.increment(jobStatus.rowsWritten),
            failures: FieldValue.increment(jobStatus.failuresCount),
            groupsProcessed: FieldValue.increment(jobStatus.groupsProcessed),
            updatedAt: nowTs,
        };
        for (const [gid, patch] of Object.entries(jobStatus.undoGroups)) {
            updates[`undo.groups.${gid}`] = patch;
        }
        await jobStatus.jobRef?.set(updates, { merge: true });
    } catch (e: any) {
        logger.warn(
            'bulkImportResults: failed to write undo metadata/counters',
            {
                orgId: jobStatus.orgId,
                jobId: jobStatus.jobId,
                error: e?.message || String(e)
            });
    }
}

// Callable: undo a previous bulk import by jobId
export const undoImport = onCall({ timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
    const { orgId, jobId } = request.data || {};
    const uid = request.auth?.uid || 'system';
    const { undo, db, jobRef } = await checkForFailures(orgId, jobId);
    const agentsList: Agent[] = await loadAgents(orgId);

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
    const auditEntries: AuditLogRecord[] = [];
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
            const stats = await checkGroupIfItShouldBeUpdated(db, orgId, groupId, undo, jobId, uid, agentsList, orgSummaryUpdate);
            // Accumulate batch counters for this group
            processedBatch += 1;
            removedBatch += (stats.removedCount || 0);
            restoredBatch += (stats.restoredCount || 0);
            if (stats.audit) {
                auditEntries.push(stats.audit);
            }
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
    if (auditEntries.length) {
        await appendAuditRecords(orgId, auditEntries);
    }
    return { ok: failures === 0, failures, revertedGroups: groupIds.length };
});




const mapsEqual = (a: Map<string, { twa: number | null; agentKey: string; }>, b: Map<string, { twa: number | null; agentKey: string; }>) => {
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


async function updateOrganizationWithExposureGroupSummary(orgSummaryUpdate: Record<string, any>, db: admin.firestore.Firestore, orgId: any) {
    try {
        if (Object.keys(orgSummaryUpdate).length > 0) {
            const orgRef = db.doc(`organizations/${orgId}`);
            await orgRef.set(orgSummaryUpdate as any, { merge: true });
        }
    } catch (e: any) {
        logger.warn('bulkImportResults: failed to write EfSummary to organization', { orgId, error: e?.message || String(e) });
    }
}

async function processIncomingSamples(
    g: SampleGroupIn,
    agentsList: Agent[],
    organizationName: any,
    jobStatus: importJobStatus,
    plantJobExtractor: PlantJobExtractor
) {

    const groupId = slugify(g.groupName);
    const parentRef = jobStatus.db?.doc(`organizations/${jobStatus.orgId}/exposureGroups/${groupId}`);
    const incoming: SampleInfo[] = (g.samples || []).map(sanitizeIncomingSampleInfo) as SampleInfo[];
    jobStatus.rowsWritten += incoming.length;
    
    // Extract plant and job from exposure group name
    const plantJobData = plantJobExtractor.extract(g.groupName);
    try {
        const txResult = await jobStatus.db?.runTransaction(async (tx: any) => {
            const snap = await tx.get(parentRef);
            const data = snap.exists ? ((snap.data() || {}) as any) : {};
            const existingResults: SampleInfo[] = Array.isArray(data.Results) ? (data.Results as any[]) : [];


            const existingNorm = (existingResults || []).map(r => normalizeResults(r, jobStatus.jobId, g, true));
            const incomingNorm = (incoming || []).map(r => normalizeResults(r, jobStatus.jobId, g, false));

            const { changedAgents, unchangedKeyTWA } = checkForChangedAgents(existingNorm, incomingNorm);

            const noKeyIncomingAgents = collectNoKeyAgents(incomingNorm);
            const noKeyExistingAgents = collectNoKeyAgents(existingNorm);
            for (const agentKey of noKeyIncomingAgents) changedAgents.add(agentKey);
            for (const agentKey of noKeyExistingAgents) changedAgents.add(agentKey);

            // Build map keyed by SampleNumber for replacement, and collect no-key entries separately
            const byCompoundKey = new Map<string, any>();
            const noKey: any[] = [];
            const replaced: Record<string, any> = {};

            for (const r of existingNorm) {
                const keyInfo = getRowKeyVariants(r);
                if (!keyInfo.compound) {
                    noKey.push(r);
                } else {
                    byCompoundKey.set(keyInfo.compound, r);
                }
            }

            for (const r of incomingNorm) {
                const keyInfo = getRowKeyVariants(r);
                if (!keyInfo.compound) {
                    // No key available; append as a distinct row
                    noKey.push(r);
                } else {
                    // Replace or add
                    const key = keyInfo.compound;
                    const prev = byCompoundKey.get(key);
                    if (prev) {
                        // Track previous row so we can restore on undo
                        replaced[key] = prev;
                        const prevKeyInfo = getRowKeyVariants(prev);
                        if (prevKeyInfo.sample && !replaced[prevKeyInfo.sample]) {
                            replaced[prevKeyInfo.sample] = prev;
                        }
                    }
                    byCompoundKey.set(key, r);
                }
            }

            const mergedUnique = [...byCompoundKey.values(), ...noKey];
            const sorted = mergedUnique.sort((a, b) => parseDateToEpoch(b.SampleDate) - parseDateToEpoch(a.SampleDate));
            const limited = sorted.slice(0, 30);
            // Prepare preview regardless; EF may be reused if inputs are unchanged
            const mostRecent = getMostRecentSamples(limited as any, 6);
            const nowTs = Timestamp.now();
            const prevLatestByAgent = normalizeLatestMap(data?.LatestExceedanceFractionByAgent);
            const hasPrevAgentSnapshots = Object.keys(prevLatestByAgent).length > 0;
            const oelChanged = hasOELChanged(hasPrevAgentSnapshots, prevLatestByAgent, agentsList);
            const shouldSkipEf = unchangedKeyTWA && hasPrevAgentSnapshots && changedAgents.size === 0 && !oelChanged;
            const prevTopCompact = compactEfSnapshot(data?.LatestExceedanceFraction);
            const auditBefore = {
                results: summarizeResultsForAudit(existingNorm as any),
                latestByAgent: compactLatestMapForAudit(prevLatestByAgent),
                latest: prevTopCompact,
            };
            if (shouldSkipEf && data?.LatestExceedanceFraction) {
                // Skip EF recompute/history if inputs unchanged; still update Results & Preview
                const payload: any = {
                    OrganizationUid: jobStatus.orgId,
                    OrganizationName: organizationName || null,
                    Group: g.groupName,
                    ExposureGroup: g.groupName,
                    plantName: plantJobData.plantName,
                    jobName: plantJobData.jobName,
                    plantKey: plantJobData.plantKey,
                    jobKey: plantJobData.jobKey,
                    plantJobNeedsReview: plantJobData.plantJobNeedsReview,
                    Results: limited,
                    ResultsPreview: mostRecent,
                    ResultsTotalCount: limited.length,
                    updatedAt: nowTs,
                    updatedBy: jobStatus.uid,
                };
                if (!snap.exists) {
                    payload.createdAt = nowTs,
                    payload.createdBy = jobStatus.uid;
                }
                tx.set(parentRef, payload, { merge: true });
                const audit: AuditLogRecord = {
                    type: 'bulk-import',
                    at: nowTs,
                    actorUid: jobStatus.uid,
                    groupId,
                    jobId: jobStatus.jobId,
                    metadata: {
                        skippedEf: true,
                        totalResultsBefore: existingNorm.length,
                        totalResultsAfter: mergedUnique.length,
                        changedAgents: Array.from(changedAgents),
                        replacedKeys: Object.keys(replaced),
                    },
                    before: auditBefore,
                    after: {
                        results: summarizeResultsForAudit(limited as any),
                        latestByAgent: compactLatestMapForAudit(prevLatestByAgent),
                        latest: prevTopCompact,
                    },
                };
                // No org summary entry necessary; no EF change
                return { entry: null, patch: { groupId, replaced }, audit };
            } else {
                const agentEfState = computeAgentEfState(limited as any, data?.LatestExceedanceFractionByAgent, data?.ExceedanceFractionHistoryByAgent, agentsList);
                let topSnapshot = agentEfState.topSnapshot;
                if (!topSnapshot) {
                    const fallbackMostRecent = getMostRecentSamples(limited as any, 6);
                    const fallbackTwa = fallbackMostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
                    const fallbackAgent = new Agent({
                        Name: 'Unknown',
                        OELNumber: 0.05,
                    });
                    const fallback = createExceedanceFraction(
                        (fallbackTwa.length >= 2) ? calculateExceedanceProbability(fallbackTwa, fallbackAgent.OELNumber) : 0,
                        fallbackMostRecent as any,
                        fallbackTwa,
                        fallbackAgent
                    ) as AgentEfSnapshot;
                    fallback.AgentKey = fallback.AgentKey || 'unknown';
                    fallback.AgentName = fallback.AgentName || 'Unknown';
                    topSnapshot = fallback;
                }
                const newTopCompact = compactEfSnapshot(topSnapshot);
                const topChanged = !deepEqual(prevTopCompact, newTopCompact);
                const byAgentSummary = Object.fromEntries(Object.entries(agentEfState.latestByAgent).map(([key, snap]) => [key, {
                    Agent: snap.AgentName,
                    AgentKey: snap.AgentKey,
                    ExceedanceFraction: snap.ExceedanceFraction,
                    DateCalculated: snap.DateCalculated,
                    SamplesUsedCount: snap.MostRecentNumber,
                    AIHARating: snap.AIHARating,
                    NinetyFifthPercentile: snap.NinetyFifthPercentile,
                    AIHARatio: snap.AIHARatio,
                }]));
                const prevEfVal = prevTopCompact?.ExceedanceFraction ?? null;
                const payload: any = {
                    OrganizationUid: jobStatus.orgId,
                    OrganizationName: organizationName || null,
                    Group: g.groupName,
                    ExposureGroup: g.groupName,
                    plantName: plantJobData.plantName,
                    jobName: plantJobData.jobName,
                    plantKey: plantJobData.plantKey,
                    jobKey: plantJobData.jobKey,
                    plantJobNeedsReview: plantJobData.plantJobNeedsReview,
                    Results: limited,
                    ResultsPreview: mostRecent,
                    ResultsTotalCount: limited.length,
                    updatedAt: nowTs,
                    updatedBy: jobStatus.uid,
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
                    payload.createdBy = jobStatus.uid;
                }
                tx.set(parentRef, payload, { merge: true });
                // Build summary entry for org-level EfSummary map
                const entry = topSnapshot ? {
                    GroupId: groupId,
                    ExposureGroup: g.groupName,
                    plantName: plantJobData.plantName,
                    jobName: plantJobData.jobName,
                    plantKey: plantJobData.plantKey,
                    jobKey: plantJobData.jobKey,
                    plantJobNeedsReview: plantJobData.plantJobNeedsReview,
                    ExceedanceFraction: topSnapshot.ExceedanceFraction,
                    PreviousExceedanceFraction: prevEfVal,
                    Agent: topSnapshot.AgentName ?? null,
                    AgentKey: topSnapshot.AgentKey ?? null,
                    OELNumber: topSnapshot.OELNumber,
                    DateCalculated: topSnapshot.DateCalculated,
                    SamplesUsedCount: topSnapshot.MostRecentNumber,
                    AIHARating: topSnapshot.AIHARating,
                    NinetyFifthPercentile: topSnapshot.NinetyFifthPercentile,
                    AIHARatio: topSnapshot.AIHARatio,
                    ByAgent: byAgentSummary,
                } : null;
                // Return both entry and undo metadata for this group
                const audit: AuditLogRecord = {
                    type: 'bulk-import',
                    at: nowTs,
                    actorUid: jobStatus.uid,
                    groupId,
                    jobId: jobStatus.jobId,
                    metadata: {
                        skippedEf: false,
                        totalResultsBefore: existingNorm.length,
                        totalResultsAfter: mergedUnique.length,
                        changedAgents: Array.from(changedAgents),
                        replacedKeys: Object.keys(replaced),
                        previousEf: prevTopCompact?.ExceedanceFraction ?? null,
                        newEf: topSnapshot?.ExceedanceFraction ?? null,
                    },
                    before: auditBefore,
                    after: {
                        results: summarizeResultsForAudit(limited as any),
                        latestByAgent: compactLatestMapForAudit(agentEfState.latestByAgent),
                        latest: newTopCompact,
                    },
                };
                return { entry, patch: { groupId, replaced }, audit };
            }
        });
        // Stage for a single org doc update after loop
        if (txResult?.entry) {
            jobStatus.orgSummaryUpdate[`EfSummary.${groupId}`] = txResult.entry;
        }
        if (txResult?.patch) {
            jobStatus.undoGroups[groupId] = txResult.patch;
        }
        if (txResult?.audit) {
            jobStatus.auditEntries.push(txResult.audit);
        }
    } catch (e: any) {
        jobStatus.failuresCount += 1;
        logger.error('bulkImportResults merge/write failed', { group: g.groupName, error: e?.message || String(e) });
    }
    return jobStatus;
}


/**
 * This method collects agent keys from rows that lack SampleNumber,
 * since these cannot be matched/replaced and must be treated as new entries.
 * 
 * @param arr 
 * @returns 
 */
function collectNoKeyAgents(arr: SampleInfo[]) {
    const set = new Set<string>();
    for (const r of (arr || [])) {
        const { sample, agentKey } = getRowKeyVariants(r);
        if (sample !== null) continue;
        if (agentKey) set.add(agentKey);
    }
    return set;
};


/**
 * This method compares existing and 
 * incoming normalized results to 
 * identify agents with changed TWA values or 
 * additions/removals.
 * @param existingNorm 
 * @param incomingNorm 
 * @returns 
 */
function checkForChangedAgents(existingNorm: ImportSampleInfo[], incomingNorm: ImportSampleInfo[]) {
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
    return { changedAgents, unchangedKeyTWA };
}

function sanitizeIncomingSampleInfo(r: IncomingSampleInfo): IncomingSampleInfo {
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
    } as IncomingSampleInfo;
}

function getIdForJob(providedJobId: any, providedImportId: any) {
    return ((): string => {
        const incoming = providedJobId || providedImportId; // support either name from client
        if (incoming && typeof incoming === 'string' && incoming.trim()) return incoming.trim();
        return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    })();
}

function hasOELChanged(hasPrevAgentSnapshots: boolean, prevLatestByAgent: Record<string, AgentEfSnapshot>, agentsList: Agent[]) {
    return (() => {
        if (!hasPrevAgentSnapshots) return false;
        for (const [agentKey, prevSnapshot] of Object.entries(prevLatestByAgent)) {
            const meta = agentsList.find(agent => slugifyAgent(agent.Name) === agentKey);
            const currentOEL = meta?.OELNumber ?? 0.05;
            const previousOEL = typeof prevSnapshot?.OELNumber === 'number' ? prevSnapshot.OELNumber : null;
            if (previousOEL === null) continue;
            if (!(previousOEL === currentOEL)) {
                return true;
            }
        }
        return false;
    })();
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



function normalizeAgent(raw: string | null | undefined): AgentNormalization {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return { key: 'unknown', name: 'Unknown' };
    return { key: slugifyAgent(value), name: value };
}






function summarizeResultsForAudit(results: SampleInfo[] | undefined): { total: number; preview: any[] } {
    const arr = Array.isArray(results) ? results : [];
    return {
        total: arr.length,
        preview: compactResults(arr.slice(0, 30)),
    };
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
/**
 * This Method checks if two numbers are almost equal within a specified epsilon.
 * @param a 
 * @param b 
 * @param epsilon - tolerance level
 * @returns 
 */
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

export function computeAgentEfState(
    samples: SampleInfo[],
    prevLatestInput: any,
    prevHistoryInput: any,
    agents: Agent[] = [],
): AgentEfState {
    const agentLookup = new Map<string, Agent>();
    for (const candidate of agents || []) {
        const key = slugifyAgent(candidate?.Name || '');
        if (!key) continue;
        if (!agentLookup.has(key)) agentLookup.set(key, candidate);
    }
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
        const displayName = agentNameMap[agentKey] || prevLatest[agentKey]?.AgentName || 'Unknown';
        const agentMeta = agentLookup.get(agentKey) || agentLookup.get(slugifyAgent(displayName)) || new Agent({ Name: displayName, OELNumber: 0.05 });
        const efVal = (twaList.length >= 2) ? calculateExceedanceProbability(twaList, agentMeta.OELNumber) : 0;
        const snapshot = createExceedanceFraction(efVal, mostRecent, twaList, agentMeta) as AgentEfSnapshot;
        snapshot.AgentKey = agentKey;
        snapshot.AgentName = displayName;
        const prev = prevLatest[agentKey];
        const prevHistoryForAgent = prevHistory[agentKey] ? [...prevHistory[agentKey]] : [];
        const sameEf = prev ? almostEqual(prev.ExceedanceFraction, snapshot.ExceedanceFraction) : false;
        const sameCount = prev ? (prev.MostRecentNumber || 0) === (snapshot.MostRecentNumber || 0) : false;
        const sameSamples = prev ? deepEqual(compactResults(prev.ResultsUsed), compactResults(snapshot.ResultsUsed)) : false;
        const sameOEL = prev ? prev.OELNumber === snapshot.OELNumber : false;
        // Check if AIHA properties are missing in the previous snapshot
        const hasAIHAProps = prev ? (prev.AIHARating !== undefined && prev.AIHARating !== null) : false;

        if (prev && sameEf && sameCount && sameSamples && sameOEL && hasAIHAProps) {
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


async function checkGroupIfItShouldBeUpdated(db: admin.firestore.Firestore, orgId: any, groupId: string, undo: any, jobId: any, uid: string, agents: Agent[], orgSummaryUpdate: Record<string, any>): Promise<{ removedCount: number, restoredCount: number, emptied: boolean, audit?: AuditLogRecord }> {
    const parentRef = db.doc(`organizations/${orgId}/exposureGroups/${groupId}`);
    let result: { removedCount: number; restoredCount: number; emptied: boolean; audit?: AuditLogRecord } = { removedCount: 0, restoredCount: 0, emptied: false };
    await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(parentRef);
        if (!snap.exists) return;
        result = undoImportsAndRespectExisting(snap, undo, groupId, jobId, uid, tx, parentRef, agents, orgSummaryUpdate);
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
    agents: Agent[],
    orgSummaryUpdate: Record<string, any>,
): { removedCount: number, restoredCount: number, emptied: boolean, audit?: AuditLogRecord } {
    const data = (snap.data() || {}) as any;
    const eGResults: any[] = Array.isArray(data.Results) ? (data.Results as any[]) : [];
    const replacedMap: Record<string, any> = (undo.groups[groupId]?.replaced || {});
    // Remove rows from this job and restore replaced ones
    const keep: any[] = [];
    const seenKeys = new Set<string>();
    let removedCount = 0;
    const normalize = (r: any): SampleInfo => (new SampleInfo({
        Location: r?.Location ?? "",
        SampleNumber: (r?.SampleNumber === undefined || r?.SampleNumber === '') ? null : r?.SampleNumber,
        SampleDate: r?.SampleDate ?? "",
        ExposureGroup: r?.ExposureGroup || r?.Group || data?.Group || data?.ExposureGroup || groupId,
        Agent: r?.Agent ?? "",
        AgentKey: r?.AgentKey || normalizeAgent(r?.Agent).key,
        TWA: (r?.TWA === '' || r?.TWA === undefined || r?.TWA === null) ? null : Number(r?.TWA),
        Notes: r?.Notes ?? "",
        ImportJobId: r?.ImportJobId ?? null,
        Group: "",
    } as SampleInfo));
    const normalizedBefore = eGResults.map(normalize);
    findExistingResults(eGResults, (result: any) => getRowKeyVariants(result), jobId, replacedMap, keep, seenKeys, (dropped: boolean) => { if (dropped) removedCount += 1; });
    // Restore replaced rows
    let restoredCount = 0;
    const restoredCanonical = new Set<string>();
    for (const [k, prev] of Object.entries(replacedMap)) {
        const { sample, compound } = getRowKeyVariants(prev);
        const keyVariants = [compound, sample, k].filter((v): v is string => typeof v === 'string' && v.length > 0);
        const canonical = compound || sample || k;
        const alreadyKept = keyVariants.some(key => seenKeys.has(key));
        if (alreadyKept || (canonical && restoredCanonical.has(canonical))) {
            if (canonical) restoredCanonical.add(canonical);
            continue;
        }
        keep.push(prev);
        restoredCount += 1;
        if (canonical) restoredCanonical.add(canonical);
        for (const key of keyVariants) {
            seenKeys.add(key);
        }
    }
    // Sort and limit
    const normalizedAfterAll = keep
        .map(normalize)
        .sort((a, b) => parseDateToEpoch(b.SampleDate) - parseDateToEpoch(a.SampleDate));
    const limited = normalizedAfterAll.slice(0, 30);
    const prevLatestByAgent = normalizeLatestMap(data?.LatestExceedanceFractionByAgent);
    const prevTopCompact = compactEfSnapshot(data?.LatestExceedanceFraction);
    const auditBefore = {
        results: summarizeResultsForAudit(normalizedBefore as any),
        latestByAgent: compactLatestMapForAudit(prevLatestByAgent),
        latest: prevTopCompact,
    };

    // If no results remain after undo, delete the group and clear org summary
    if (limited.length === 0) {
        const audit: AuditLogRecord = {
            type: 'undo-import',
            at: Timestamp.now(),
            actorUid: uid,
            groupId,
            jobId: typeof jobId === 'string' ? jobId : null,
            metadata: {
                removedCount,
                restoredCount,
                emptied: true,
            },
            before: auditBefore,
            after: {
                results: summarizeResultsForAudit([]),
                latestByAgent: {},
                latest: null,
            },
        };
        tx.delete(parentRef);
        orgSummaryUpdate[`EfSummary.${groupId}`] = FieldValue.delete();
        return { removedCount, restoredCount, emptied: true, audit };
    }

    const mostRecent = getMostRecentSamples(limited as any, 6);

    const agentEfState: AgentEfState = computeAgentEfState(
        limited as any,
        data?.LatestExceedanceFractionByAgent,
        data?.ExceedanceFractionHistoryByAgent,
        agents
    );
    let topSnapshot = agentEfState.topSnapshot;
    if (!topSnapshot) {
        const fallbackTwa = mostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
        const fallbackAgent = new Agent({
            Name: 'Unknown',
            OELNumber: 0.05,
        });
        const fallback = createExceedanceFraction((fallbackTwa.length >= 2) ? calculateExceedanceProbability(fallbackTwa, fallbackAgent.OELNumber) : 0, mostRecent as any, fallbackTwa, fallbackAgent) as AgentEfSnapshot;
        fallback.AgentKey = fallback.AgentKey || 'unknown';
        fallback.AgentName = fallback.AgentName || 'Unknown';
        topSnapshot = fallback;
    }
    const newTopCompact = compactEfSnapshot(topSnapshot);
    const topChanged = !deepEqual(prevTopCompact, newTopCompact);
    const byAgentSummary = Object.fromEntries(Object.entries(agentEfState.latestByAgent).map(([key, snap]) => [key, {
        Agent: snap.AgentName,
        AgentKey: snap.AgentKey,
        ExceedanceFraction: snap.ExceedanceFraction,
        DateCalculated: snap.DateCalculated,
        SamplesUsedCount: snap.MostRecentNumber,
        AIHARating: snap.AIHARating,
        NinetyFifthPercentile: snap.NinetyFifthPercentile,
        AIHARatio: snap.AIHARatio,
    }]));
    const nowTs = Timestamp.now();

    const payload: any = {
        Results: limited,
        ResultsPreview: mostRecent,
        ResultsTotalCount: limited.length,
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
        AIHARating: topSnapshot.AIHARating,
        NinetyFifthPercentile: topSnapshot.NinetyFifthPercentile,
        AIHARatio: topSnapshot.AIHARatio,
        ByAgent: byAgentSummary,
    } : null;
    if (summaryEntry) {
        orgSummaryUpdate[`EfSummary.${groupId}`] = summaryEntry;
    } else {
        orgSummaryUpdate[`EfSummary.${groupId}`] = FieldValue.delete();
    }
    const audit: AuditLogRecord = {
        type: 'undo-import',
        at: nowTs,
        actorUid: uid,
        groupId,
        jobId: typeof jobId === 'string' ? jobId : null,
        metadata: {
            removedCount,
            restoredCount,
            emptied: false,
            totalResultsBefore: normalizedBefore.length,
            totalResultsAfter: normalizedAfterAll.length,
        },
        before: auditBefore,
        after: {
            results: summarizeResultsForAudit(normalizedAfterAll as any),
            latestByAgent: compactLatestMapForAudit(agentEfState.latestByAgent),
            latest: newTopCompact,
        },
    };

    return { removedCount, restoredCount, emptied: false, audit };
}

function findExistingResults(
    eGResults: any[],
    getKeyVariants: (result: any) => { sample: string | null; compound: string | null; agentKey: string },
    jobId: any,
    replacedMap: Record<string, any>,
    keep: any[],
    seenKeys: Set<string>,
    onDrop?: (dropped: boolean) => void,
) {
    for (const result of eGResults) {
        const { sample, compound } = getKeyVariants(result);
        const keyCandidates = [compound, sample].filter((v): v is string => typeof v === 'string' && v.length > 0);
        const isFromJob = result?.ImportJobId === jobId;
        if (isFromJob) {
            if (onDrop) onDrop(true);
            continue;
        }
        const shouldSkip = keyCandidates.some(key => replacedMap[key]);
        if (shouldSkip) {
            continue;
        }
        keep.push(result);
        for (const key of keyCandidates) {
            seenKeys.add(key);
        }
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


export const removeAgentsFromExposureGroups = onCall(async (request) => {
    const { orgId, removals, trackJob, jobId: providedJobId, totalAgents: totalAgentsProvided, totalGroups: totalGroupsProvided } = request.data || {};
    const uid = request.auth?.uid || 'system';
    if (!orgId || typeof orgId !== 'string') {
        throw new HttpsError('invalid-argument', 'orgId required');
    }
    if (!Array.isArray(removals) || removals.length === 0) {
        throw new HttpsError('invalid-argument', 'removals[] required');
    }
    const normalizedRemovals = new Map<string, Set<string>>();
    for (const entry of removals as any[]) {
        const rawGroupId = typeof entry?.groupId === 'string' ? entry.groupId.trim() : '';
        const rawKey = typeof entry?.agentKey === 'string' ? entry.agentKey.trim() : '';
        if (!rawGroupId || !rawKey) continue;
        const groupId = rawGroupId;
        const agentKey = slugifyAgent(rawKey);
        if (!normalizedRemovals.has(groupId)) normalizedRemovals.set(groupId, new Set<string>());
        normalizedRemovals.get(groupId)!.add(agentKey);
    }
    if (!normalizedRemovals.size) {
        throw new HttpsError('invalid-argument', 'No valid removals provided');
    }
    const db = getFirestore();
    const totalGroupsTarget = typeof totalGroupsProvided === 'number' ? totalGroupsProvided : normalizedRemovals.size;
    const totalAgentsTarget = typeof totalAgentsProvided === 'number'
        ? totalAgentsProvided
        : Array.from(normalizedRemovals.values()).reduce((sum, agents) => sum + agents.size, 0);
    const shouldTrackJob = !!trackJob;
    const jobId = shouldTrackJob ? ((): string => {
        const incoming = typeof providedJobId === 'string' ? providedJobId.trim() : '';
        if (incoming) return incoming;
        return `agentRemoval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    })() : null;
    const jobRef = shouldTrackJob && jobId ? db.doc(`organizations/${orgId}/agentRemovalJobs/${jobId}`) : null;
    let jobDocAvailable = !!jobRef;
    if (jobRef) {
        try {
            await jobRef.set({
                status: 'running',
                totalGroups: totalGroupsTarget,
                totalAgents: totalAgentsTarget,
                groupsProcessed: 0,
                groupsDeleted: 0,
                agentsRemoved: 0,
                failures: 0,
                startedAt: Timestamp.now(),
                updatedAt: Timestamp.now(),
                updatedBy: uid,
            }, { merge: true });
        } catch (e: any) {
            logger.warn('removeAgentsFromExposureGroups: failed to init job doc', { orgId, jobId, error: e?.message || String(e) });
            jobDocAvailable = false;
        }
    }
    const flushProgress = async (delta: { groups?: number; agents?: number; failures?: number; groupsDeleted?: number }) => {
        if (!jobRef || !jobDocAvailable) return;
        const payload: any = { updatedAt: Timestamp.now() };
        if (delta.groups) payload.groupsProcessed = FieldValue.increment(delta.groups);
        if (delta.agents) payload.agentsRemoved = FieldValue.increment(delta.agents);
        if (delta.failures) payload.failures = FieldValue.increment(delta.failures);
        if (delta.groupsDeleted) payload.groupsDeleted = FieldValue.increment(delta.groupsDeleted);
        try {
            await jobRef.set(payload, { merge: true });
        } catch (e: any) {
            logger.warn('removeAgentsFromExposureGroups: progress update failed', { orgId, jobId, error: e?.message || String(e) });
            jobDocAvailable = false;
        }
    };
    const orgSummaryUpdate: Record<string, any> = {};
    let removedAgentsTotal = 0;
    let groupsDeletedTotal = 0;
    let failuresTotal = 0;
    let processedTotal = 0;
    const queue = Array.from(normalizedRemovals.entries());
    const workerCount = Math.min(Math.max(1, Number(process.env.REMOVE_AGENTS_CONCURRENCY || 8)), queue.length || 1);
    const workers = new Array(workerCount).fill(0).map(async () => {
        while (queue.length) {
            const next = queue.pop();
            if (!next) break;
            const [groupId, agentKeys] = next;
            const parentRef = db.doc(`organizations/${orgId}/exposureGroups/${groupId}`);
            try {
                const outcome = await db.runTransaction(async (tx: any) => {
                    const snap = await tx.get(parentRef);
                    if (!snap.exists) {
                        return { status: 'missing', removedAgentsCount: 0 };
                    }
                    const data = (snap.data() || {}) as any;
                    const removalSet = new Set<string>(Array.from(agentKeys).map(slugifyAgent));
                    const existingResults: any[] = Array.isArray(data.Results) ? data.Results as any[] : [];
                    const normalized = existingResults.map(r => ({
                        Location: r?.Location ?? "",
                        SampleNumber: (r?.SampleNumber === undefined || r?.SampleNumber === '') ? null : r?.SampleNumber,
                        SampleDate: r?.SampleDate ?? "",
                        ExposureGroup: r?.ExposureGroup || r?.Group || data?.ExposureGroup || data?.Group || groupId,
                        Agent: typeof r?.Agent === 'string' ? r.Agent.trim() : '',
                        AgentKey: r?.AgentKey || normalizeAgent(r?.Agent).key,
                        TWA: (r?.TWA === '' || r?.TWA === undefined || r?.TWA === null) ? null : Number(r?.TWA),
                        Notes: r?.Notes ?? "",
                        ImportJobId: r?.ImportJobId ?? null,
                        Group: "",
                    })) as SampleInfo[];
                    const filtered = normalized.filter(r => {
                        const key = r?.AgentKey || normalizeAgent(r?.Agent).key;
                        if (!key) return true;
                        return !removalSet.has(slugifyAgent(key));
                    });
                    const filteredAgentKeys = new Set(filtered.map(r => slugifyAgent(r?.AgentKey || normalizeAgent(r?.Agent).key)));
                    const removedAgentKeyList = Array.from(removalSet).filter(key => !filteredAgentKeys.has(key));
                    const removedAgentsCount = removedAgentKeyList.length;
                    if (!filtered.length) {
                        tx.delete(parentRef);
                        return { status: 'deleted', summary: FieldValue.delete(), removedAgentsCount: Math.max(removedAgentsCount, removalSet.size) };
                    }
                    const sorted = [...filtered].sort((a, b) => parseDateToEpoch(b.SampleDate) - parseDateToEpoch(a.SampleDate));
                    const limited = sorted.slice(0, 30);
                    const recomputeState = computeAgentEfState(limited as any, data?.LatestExceedanceFractionByAgent, data?.ExceedanceFractionHistoryByAgent);
                    let topSnapshot = recomputeState.topSnapshot;
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
                    const byAgentSummary = Object.fromEntries(Object.entries(recomputeState.latestByAgent).map(([key, snap]) => [key, {
                        Agent: snap.AgentName,
                        AgentKey: snap.AgentKey,
                        ExceedanceFraction: snap.ExceedanceFraction,
                        DateCalculated: snap.DateCalculated,
                        SamplesUsedCount: snap.MostRecentNumber,
                        AIHARating: snap.AIHARating,
                        NinetyFifthPercentile: snap.NinetyFifthPercentile,
                        AIHARatio: snap.AIHARatio,
                    }]));
                    const nowTs = Timestamp.now();
                    const latestByAgentPayload: Record<string, any> = {};
                    for (const [key, snapshot] of Object.entries(recomputeState.latestByAgent)) {
                        latestByAgentPayload[key] = snapshot;
                    }
                    const historyByAgentPayload: Record<string, any> = {};
                    for (const [key, history] of Object.entries(recomputeState.historyByAgent)) {
                        historyByAgentPayload[key] = history;
                    }
                    for (const removedKey of recomputeState.removedAgentKeys) {
                        latestByAgentPayload[removedKey] = FieldValue.delete();
                        historyByAgentPayload[removedKey] = FieldValue.delete();
                    }

                    const payload: any = {
                        Results: limited,
                        ResultsPreview: getMostRecentSamples(limited as any, 6),
                        ResultsTotalCount: limited.length,
                        LatestExceedanceFractionByAgent: latestByAgentPayload,
                        ExceedanceFractionHistoryByAgent: historyByAgentPayload,
                        updatedAt: nowTs,
                        updatedBy: uid,
                    };
                    if (topSnapshot) {
                        payload.LatestExceedanceFraction = topSnapshot;
                        if (topChanged || !data?.LatestExceedanceFraction) {
                            payload.ExceedanceFractionHistory = FieldValue.arrayUnion(topSnapshot as any);
                            payload.EFComputedAt = nowTs;
                        }
                    }
                    tx.set(parentRef, payload, { merge: true });
                    const summaryEntry = topSnapshot ? {
                        GroupId: groupId,
                        ExposureGroup: data?.ExposureGroup || data?.Group || groupId,
                        ExceedanceFraction: topSnapshot.ExceedanceFraction,
                        PreviousExceedanceFraction: prevTopCompact?.ExceedanceFraction ?? null,
                        Agent: topSnapshot.AgentName ?? null,
                        AgentKey: topSnapshot.AgentKey ?? null,
                        OELNumber: topSnapshot.OELNumber,
                        DateCalculated: topSnapshot.DateCalculated,
                        SamplesUsedCount: topSnapshot.MostRecentNumber,
                        AIHARating: topSnapshot.AIHARating,
                        NinetyFifthPercentile: topSnapshot.NinetyFifthPercentile,
                        AIHARatio: topSnapshot.AIHARatio,
                        ByAgent: byAgentSummary,
                    } : FieldValue.delete();
                    return { status: 'updated', summary: summaryEntry, removedAgentsCount };
                });
                if (outcome.status === 'deleted') {
                    orgSummaryUpdate[`EfSummary.${groupId}`] = FieldValue.delete();
                    groupsDeletedTotal += 1;
                } else if (outcome.status === 'updated' && outcome.summary) {
                    orgSummaryUpdate[`EfSummary.${groupId}`] = outcome.summary;
                }
                const removedCount = outcome.removedAgentsCount || 0;
                removedAgentsTotal += removedCount;
                await flushProgress({ groups: 1, agents: removedCount, groupsDeleted: outcome.status === 'deleted' ? 1 : undefined });
            } catch (e: any) {
                failuresTotal += 1;
                logger.error('removeAgentsFromExposureGroups worker failed', { orgId, groupId, error: e?.message || String(e) });
                await flushProgress({ groups: 1, agents: 0, failures: 1 });
            }
            processedTotal += 1;
        }
    });
    await Promise.all(workers);
    if (Object.keys(orgSummaryUpdate).length > 0) {
        const orgRef = db.doc(`organizations/${orgId}`);
        await orgRef.set(orgSummaryUpdate as any, { merge: true });
    }
    if (jobRef && jobDocAvailable) {
        try {
            await jobRef.set({
                status: failuresTotal > 0 ? 'completed-with-errors' : 'completed',
                completedAt: Timestamp.now(),
                updatedAt: Timestamp.now(),
                groupsProcessed: processedTotal,
                groupsDeleted: groupsDeletedTotal,
                agentsRemoved: removedAgentsTotal,
                failures: failuresTotal,
            }, { merge: true });
        } catch (e: any) {
            logger.warn('removeAgentsFromExposureGroups: finalize job failed', { orgId, jobId, error: e?.message || String(e) });
        }
    }
    return { ok: true, groups: normalizedRemovals.size, removedAgents: removedAgentsTotal, jobId, groupsDeleted: groupsDeletedTotal, failures: failuresTotal };
});

interface SampleDeletionCriteria {
    sampleNumber: string | null;
    sampleDate: string | null;
    agentKey: string | null;
    twa: number | null;
}

function normalizeSampleNumberInput(value: any): string | null {
    if (value === undefined || value === null) return null;
    const str = String(value).trim();
    return str ? str : null;
}

function normalizeDateForMatch(value: any): string | null {
    if (!value) return null;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const parsed = new Date(trimmed);
        if (!isNaN(parsed.getTime())) {
            return parsed.toISOString().slice(0, 10);
        }
        if (trimmed.includes('T')) {
            const [datePart] = trimmed.split('T');
            if (datePart) return datePart;
        }
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
        return trimmed;
    }
    if (value instanceof Date) {
        return value.toISOString().slice(0, 10);
    }
    if (typeof value?.toDate === 'function') {
        try {
            return value.toDate().toISOString().slice(0, 10);
        } catch {
            return null;
        }
    }
    return null;
}

function normalizeTwaValue(value: any): number | null {
    if (value === undefined || value === null || value === '') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function normalizeSampleDeletionCriteria(input: any): SampleDeletionCriteria | null {
    if (!input || typeof input !== 'object') return null;
    const sampleNumber = normalizeSampleNumberInput(input?.sampleNumber ?? input?.SampleNumber);
    const sampleDate = normalizeDateForMatch(input?.sampleDate ?? input?.SampleDate);
    const agentSource = input?.agentKey ?? input?.AgentKey ?? input?.agent ?? input?.Agent;
    const agentKey = (typeof agentSource === 'string' && agentSource.trim()) ? slugifyAgent(agentSource.trim()) : null;
    const twa = normalizeTwaValue(input?.twa ?? input?.TWA);
    if (!sampleNumber && !sampleDate && !agentKey) {
        return null;
    }
    return { sampleNumber, sampleDate, agentKey, twa };
}

function normalizeSampleForMatching(sample: any): SampleDeletionCriteria {
    const sampleNumber = normalizeSampleNumberInput(sample?.SampleNumber ?? sample?.sampleNumber);
    const sampleDate = normalizeDateForMatch(sample?.SampleDate ?? sample?.sampleDate);
    const agentSource = sample?.AgentKey ?? sample?.agentKey ?? sample?.Agent ?? sample?.agent ?? '';
    const agentKey = slugifyAgent(String(agentSource || ''));
    const twa = normalizeTwaValue(sample?.TWA ?? sample?.twa);
    return { sampleNumber, sampleDate, agentKey, twa };
}

function matchesSample(candidate: any, criteria: SampleDeletionCriteria): boolean {
    const normalized = normalizeSampleForMatching(candidate);
    if (criteria.sampleNumber) {
        if (!normalized.sampleNumber || normalized.sampleNumber !== criteria.sampleNumber) return false;
    }
    if (criteria.agentKey) {
        if (!normalized.agentKey || normalized.agentKey !== criteria.agentKey) return false;
    }
    if (criteria.sampleDate) {
        if (!normalized.sampleDate || normalized.sampleDate !== criteria.sampleDate) return false;
    }
    if (criteria.twa !== null && criteria.twa !== undefined) {
        if (!almostEqual(normalized.twa, criteria.twa)) return false;
    }
    return true;
}

export const deleteSamplesFromExposureGroup = onCall(async (request) => {
    const { orgId, groupId, samples } = request.data || {};
    const uid = request.auth?.uid || 'system';
    if (!orgId || typeof orgId !== 'string') {
        throw new HttpsError('invalid-argument', 'orgId required');
    }
    if (!groupId || typeof groupId !== 'string') {
        throw new HttpsError('invalid-argument', 'groupId required');
    }
    if (!Array.isArray(samples) || samples.length === 0) {
        throw new HttpsError('invalid-argument', 'samples[] required');
    }
    const criteriaList = (samples as any[])
        .map(entry => normalizeSampleDeletionCriteria(entry))
        .filter((entry): entry is SampleDeletionCriteria => !!entry);
    if (!criteriaList.length) {
        throw new HttpsError('invalid-argument', 'No valid sample descriptors provided');
    }
    const db = getFirestore();
    const parentRef = db.doc(`organizations/${orgId}/exposureGroups/${groupId}`);
    const outcome = await db.runTransaction(async (tx: any) => {
        const snap = await tx.get(parentRef);
        if (!snap.exists) {
            throw new HttpsError('not-found', 'Exposure group not found');
        }
        const data = (snap.data() || {}) as any;
        const existing: any[] = Array.isArray(data.Results) ? [...data.Results] : [];
        if (!existing.length) {
            throw new HttpsError('failed-precondition', 'No samples available to delete');
        }
        const remaining = [...existing];
        const removed: any[] = [];
        for (const criteria of criteriaList) {
            const idx = remaining.findIndex(candidate => matchesSample(candidate, criteria));
            if (idx === -1) continue;
            const [deleted] = remaining.splice(idx, 1);
            removed.push(deleted);
        }
        if (!removed.length) {
            throw new HttpsError('not-found', 'No matching samples found in this exposure group');
        }
        if (!remaining.length) {
            tx.delete(parentRef);
            return { status: 'deleted', removedCount: removed.length, summary: null };
        }
        const normalize = (r: any): SampleInfo => new SampleInfo({
            Location: r?.Location ?? "",
            SampleNumber: (r?.SampleNumber === undefined || r?.SampleNumber === '') ? null : r?.SampleNumber,
            SampleDate: r?.SampleDate ?? "",
            ExposureGroup: r?.ExposureGroup || r?.Group || data?.ExposureGroup || data?.Group || groupId,
            Agent: typeof r?.Agent === 'string' ? r.Agent.trim() : '',
            AgentKey: r?.AgentKey || normalizeAgent(r?.Agent).key,
            TWA: (r?.TWA === '' || r?.TWA === undefined || r?.TWA === null) ? null : Number(r?.TWA),
            Notes: r?.Notes ?? "",
            ImportJobId: r?.ImportJobId ?? null,
            Group: "",
        } as SampleInfo);
        const normalized = remaining.map(normalize);
        const sorted = [...normalized].sort((a, b) => parseDateToEpoch(b.SampleDate) - parseDateToEpoch(a.SampleDate));
        const limited = sorted.slice(0, 30);
        const preview = getMostRecentSamples(limited as any, 6);
        const agentEfState = computeAgentEfState(limited as any, data?.LatestExceedanceFractionByAgent, data?.ExceedanceFractionHistoryByAgent);
        let topSnapshot = agentEfState.topSnapshot;
        if (!topSnapshot) {
            const fallbackMostRecent = getMostRecentSamples(sorted as any, 6);
            const fallbackTwa = fallbackMostRecent.map(r => Number(r.TWA)).filter(n => n > 0);
            const fallbackAgent = new Agent({ Name: 'Unknown', OELNumber: 0.05 });
            const fallback = createExceedanceFraction(
                (fallbackTwa.length >= 2) ? calculateExceedanceProbability(fallbackTwa, fallbackAgent.OELNumber) : 0,
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
            AIHARating: snap.AIHARating,
            NinetyFifthPercentile: snap.NinetyFifthPercentile,
            AIHARatio: snap.AIHARatio,
        }]));
        const nowTs = Timestamp.now();
        const latestPayload: Record<string, any> = {};
        for (const [key, snapshot] of Object.entries(agentEfState.latestByAgent)) {
            latestPayload[key] = snapshot;
        }
        const historyPayload: Record<string, any> = {};
        for (const [key, history] of Object.entries(agentEfState.historyByAgent)) {
            historyPayload[key] = history;
        }
        for (const removedKey of agentEfState.removedAgentKeys) {
            latestPayload[removedKey] = FieldValue.delete();
            historyPayload[removedKey] = FieldValue.delete();
        }
        const payload: any = {
            Results: limited,
            ResultsPreview: preview,
            ResultsTotalCount: limited.length,
            LatestExceedanceFractionByAgent: latestPayload,
            ExceedanceFractionHistoryByAgent: historyPayload,
            updatedAt: nowTs,
            updatedBy: uid,
        };
        if (topSnapshot) {
            payload.LatestExceedanceFraction = topSnapshot;
            if (topChanged || !data?.LatestExceedanceFraction) {
                payload.ExceedanceFractionHistory = FieldValue.arrayUnion(topSnapshot as any);
                payload.EFComputedAt = nowTs;
            }
        }
        tx.set(parentRef, payload, { merge: true });
        const summaryEntry = topSnapshot ? {
            GroupId: groupId,
            ExposureGroup: data?.ExposureGroup || data?.Group || groupId,
            ExceedanceFraction: topSnapshot.ExceedanceFraction,
            PreviousExceedanceFraction: prevTopCompact?.ExceedanceFraction ?? null,
            Agent: topSnapshot.AgentName ?? null,
            AgentKey: topSnapshot.AgentKey ?? null,
            OELNumber: topSnapshot.OELNumber,
            DateCalculated: topSnapshot.DateCalculated,
            SamplesUsedCount: topSnapshot.MostRecentNumber,
            AIHARating: topSnapshot.AIHARating,
            NinetyFifthPercentile: topSnapshot.NinetyFifthPercentile,
            AIHARatio: topSnapshot.AIHARatio,
            ByAgent: byAgentSummary,
        } : null;
        return { status: 'updated', removedCount: removed.length, summary: summaryEntry };
    });
    const orgSummaryUpdate: Record<string, any> = {};
    if (outcome.status === 'deleted') {
        orgSummaryUpdate[`EfSummary.${groupId}`] = FieldValue.delete();
    } else if (outcome.summary) {
        orgSummaryUpdate[`EfSummary.${groupId}`] = outcome.summary;
    }
    if (Object.keys(orgSummaryUpdate).length > 0) {
        const orgRef = db.doc(`organizations/${orgId}`);
        await orgRef.set(orgSummaryUpdate as any, { merge: true });
    }
    return { ok: true, removed: outcome.removedCount, status: outcome.status };
});



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
            AIHARating: snap.AIHARating,
            NinetyFifthPercentile: snap.NinetyFifthPercentile,
            AIHARatio: snap.AIHARatio,
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
                AIHARating: topSnapshot.AIHARating,
                NinetyFifthPercentile: topSnapshot.NinetyFifthPercentile,
                AIHARatio: topSnapshot.AIHARatio,
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

/**
 * Retroactively add AIHA ratings to existing exceedance fractions
 * This function updates all exposure groups to add AIHA rating data to their
 * LatestExceedanceFractionByAgent and ExceedanceFractionHistoryByAgent snapshots
 */
export const addAIHARatingsRetroactively = onCall({ timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
    const { orgId, groupIds } = request.data || {};

    if (!orgId) {
        throw new HttpsError('invalid-argument', 'orgId required');
    }

    const db = getFirestore();
    const processedGroups: string[] = [];
    const errors: string[] = [];

    // If groupIds not provided, fetch all groups
    let targetGroupIds = groupIds;
    if (!targetGroupIds || !Array.isArray(targetGroupIds) || targetGroupIds.length === 0) {
        const groupsSnapshot = await db.collection(`organizations/${orgId}/exposureGroups`).get();
        targetGroupIds = groupsSnapshot.docs.map(doc => doc.id);
    }

    logger.info('addAIHARatingsRetroactively: starting', { orgId, groupCount: targetGroupIds.length });

    for (const groupId of targetGroupIds) {
        try {
            const groupRef = db.doc(`organizations/${orgId}/exposureGroups/${groupId}`);

            await db.runTransaction(async (tx: any) => {
                const snap = await tx.get(groupRef);
                if (!snap.exists) return;

                const data = snap.data() || {};
                let updated = false;

                // Update LatestExceedanceFractionByAgent
                if (data.LatestExceedanceFractionByAgent && typeof data.LatestExceedanceFractionByAgent === 'object') {
                    const latestByAgent = data.LatestExceedanceFractionByAgent;
                    for (const [, snapshot] of Object.entries(latestByAgent)) {
                        if (snapshot && typeof snapshot === 'object') {
                            const snap = snapshot as any;
                            // Only add if AIHA rating doesn't exist
                            if (snap.AIHARating === undefined || snap.AIHARating === null) {
                                const resultsUsed = snap.ResultsUsed || [];
                                const twaList = resultsUsed
                                    .map((r: any) => r.TWA)
                                    .filter((twa: any): twa is number => typeof twa === 'number' && !isNaN(twa) && twa > 0);

                                if (twaList.length > 0) {
                                    const ninetyFifthPercentile = calculate95thPercentile(twaList);
                                    const aihaRatio = snap.OELNumber > 0 ? ninetyFifthPercentile / snap.OELNumber : 0;
                                    const aihaRating = calculateAIHARating(ninetyFifthPercentile, snap.OELNumber);

                                    snap.AIHARating = aihaRating;
                                    snap.NinetyFifthPercentile = ninetyFifthPercentile;
                                    snap.AIHARatio = aihaRatio;
                                    updated = true;
                                }
                            }
                        }
                    }

                    if (updated) {
                        tx.set(groupRef, { LatestExceedanceFractionByAgent: latestByAgent }, { merge: true });
                    }
                }

                // Update ExceedanceFractionHistoryByAgent
                if (data.ExceedanceFractionHistoryByAgent && typeof data.ExceedanceFractionHistoryByAgent === 'object') {
                    const historyByAgent = data.ExceedanceFractionHistoryByAgent;
                    let historyUpdated = false;

                    for (const [, history] of Object.entries(historyByAgent)) {
                        if (Array.isArray(history)) {
                            for (const snapshot of history) {
                                if (snapshot && typeof snapshot === 'object') {
                                    const snap = snapshot as any;
                                    // Only add if AIHA rating doesn't exist
                                    if (snap.AIHARating === undefined || snap.AIHARating === null) {
                                        const resultsUsed = snap.ResultsUsed || [];
                                        const twaList = resultsUsed
                                            .map((r: any) => r.TWA)
                                            .filter((twa: any): twa is number => typeof twa === 'number' && !isNaN(twa) && twa > 0);

                                        if (twaList.length > 0) {
                                            const ninetyFifthPercentile = calculate95thPercentile(twaList);
                                            const aihaRatio = snap.OELNumber > 0 ? ninetyFifthPercentile / snap.OELNumber : 0;
                                            const aihaRating = calculateAIHARating(ninetyFifthPercentile, snap.OELNumber);

                                            snap.AIHARating = aihaRating;
                                            snap.NinetyFifthPercentile = ninetyFifthPercentile;
                                            snap.AIHARatio = aihaRatio;
                                            historyUpdated = true;
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if (historyUpdated) {
                        tx.set(groupRef, { ExceedanceFractionHistoryByAgent: historyByAgent }, { merge: true });
                    }
                }

                // Update legacy LatestExceedanceFraction if it exists
                if (data.LatestExceedanceFraction && typeof data.LatestExceedanceFraction === 'object') {
                    const snap = data.LatestExceedanceFraction as any;
                    if (snap.AIHARating === undefined || snap.AIHARating === null) {
                        const resultsUsed = snap.ResultsUsed || [];
                        const twaList = resultsUsed
                            .map((r: any) => r.TWA)
                            .filter((twa: any): twa is number => typeof twa === 'number' && !isNaN(twa) && twa > 0);

                        if (twaList.length > 0) {
                            const ninetyFifthPercentile = calculate95thPercentile(twaList);
                            const aihaRatio = snap.OELNumber > 0 ? ninetyFifthPercentile / snap.OELNumber : 0;
                            const aihaRating = calculateAIHARating(ninetyFifthPercentile, snap.OELNumber);

                            snap.AIHARating = aihaRating;
                            snap.NinetyFifthPercentile = ninetyFifthPercentile;
                            snap.AIHARatio = aihaRatio;

                            tx.set(groupRef, { LatestExceedanceFraction: snap }, { merge: true });
                        }
                    }
                }
            });

            processedGroups.push(groupId);
        } catch (e: any) {
            logger.error('addAIHARatingsRetroactively: failed for group', { orgId, groupId, error: e?.message || String(e) });
            errors.push(`${groupId}: ${e?.message || String(e)}`);
        }
    }

    logger.info('addAIHARatingsRetroactively: completed', {
        orgId,
        processedCount: processedGroups.length,
        errorCount: errors.length
    });

    return {
        ok: errors.length === 0,
        processedCount: processedGroups.length,
        errorCount: errors.length,
        errors: errors.slice(0, 10) // Return first 10 errors to avoid too large response
    };
});