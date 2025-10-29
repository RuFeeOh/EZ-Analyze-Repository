/**
 * Backfill Plant/Job Data for Existing Exposure Groups
 * 
 * This module provides a Cloud Function to retroactively add plant/job extraction
 * to all existing exposure groups in an organization.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { PlantJobExtractor } from "./plant-job-extraction";

/**
 * Backfill plant/job data for all exposure groups in an organization
 */
export const backfillPlantJobData = onCall({ timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
    const { orgId, groupIds, dryRun } = request.data || {};
    const uid = request.auth?.uid || 'system';
    
    if (!orgId || typeof orgId !== 'string') {
        throw new HttpsError('invalid-argument', 'orgId required');
    }
    
    const db = getFirestore();
    const isDryRun = dryRun === true;
    
    logger.info('backfillPlantJobData: starting', { orgId, isDryRun });
    
    // Load all exposure groups for the organization
    let targetGroupIds: string[] = [];
    const exposureGroupsRef = db.collection(`organizations/${orgId}/exposureGroups`);
    
    if (groupIds && Array.isArray(groupIds) && groupIds.length > 0) {
        // Process specific groups
        targetGroupIds = groupIds;
    } else {
        // Process all groups
        const snapshot = await exposureGroupsRef.select('ExposureGroup', 'Group').get();
        targetGroupIds = snapshot.docs.map(doc => doc.id);
    }
    
    if (targetGroupIds.length === 0) {
        return {
            ok: true,
            message: 'No exposure groups found',
            processedCount: 0,
            updatedCount: 0,
            skippedCount: 0,
            flaggedForReviewCount: 0,
            errors: []
        };
    }
    
    // Load existing exposure group names for plant dictionary
    const existingNames: string[] = [];
    const allGroupsSnapshot = await exposureGroupsRef.select('ExposureGroup', 'Group').limit(500).get();
    allGroupsSnapshot.forEach(doc => {
        const data = doc.data();
        const name = data?.ExposureGroup || data?.Group;
        if (name && typeof name === 'string') {
            existingNames.push(name);
        }
    });
    
    // Initialize plant/job extractor with existing names
    const extractor = new PlantJobExtractor(existingNames);
    
    // Process groups
    let processedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let flaggedForReviewCount = 0;
    const errors: string[] = [];
    const orgSummaryUpdate: Record<string, any> = {};
    
    // Process in batches to avoid overwhelming Firestore
    const BATCH_SIZE = 50;
    for (let i = 0; i < targetGroupIds.length; i += BATCH_SIZE) {
        const batch = targetGroupIds.slice(i, i + BATCH_SIZE);
        
        const batchPromises = batch.map(async (groupId) => {
            try {
                const docRef = db.doc(`organizations/${orgId}/exposureGroups/${groupId}`);
                const doc = await docRef.get();
                
                if (!doc.exists) {
                    return { status: 'skip', reason: 'not-found' };
                }
                
                const data = doc.data() as any;
                const exposureGroupName = data?.ExposureGroup || data?.Group || '';
                
                if (!exposureGroupName) {
                    return { status: 'skip', reason: 'no-name' };
                }
                
                // Check if already has plant/job data
                const hasPlantJobData = !!(data?.plantName && data?.jobName);
                
                // Extract plant/job
                const extraction = extractor.extract(exposureGroupName);
                
                // Update the exposure group document
                if (!isDryRun) {
                    const payload: any = {
                        plantName: extraction.plantName,
                        jobName: extraction.jobName,
                        plantKey: extraction.plantKey,
                        jobKey: extraction.jobKey,
                        plantJobNeedsReview: extraction.plantJobNeedsReview,
                        updatedAt: Timestamp.now(),
                        updatedBy: uid
                    };
                    
                    await docRef.set(payload, { merge: true });
                    
                    // Update org-level EfSummary if exists
                    const efSummaryKey = `EfSummary.${groupId}`;
                    if (data?.LatestExceedanceFraction) {
                        orgSummaryUpdate[`${efSummaryKey}.plantName`] = extraction.plantName;
                        orgSummaryUpdate[`${efSummaryKey}.jobName`] = extraction.jobName;
                        orgSummaryUpdate[`${efSummaryKey}.plantKey`] = extraction.plantKey;
                        orgSummaryUpdate[`${efSummaryKey}.jobKey`] = extraction.jobKey;
                        orgSummaryUpdate[`${efSummaryKey}.plantJobNeedsReview`] = extraction.plantJobNeedsReview;
                    }
                }
                
                return {
                    status: 'updated',
                    groupId,
                    exposureGroupName,
                    extraction,
                    wasAlreadySet: hasPlantJobData
                };
            } catch (e: any) {
                logger.error('backfillPlantJobData: failed to process group', {
                    orgId,
                    groupId,
                    error: e?.message || String(e)
                });
                return {
                    status: 'error',
                    groupId,
                    error: e?.message || String(e)
                };
            }
        });
        
        const results = await Promise.all(batchPromises);
        
        for (const result of results) {
            processedCount++;
            
            if (result.status === 'updated') {
                if (!result.wasAlreadySet) {
                    updatedCount++;
                }
                if (result.extraction?.plantJobNeedsReview) {
                    flaggedForReviewCount++;
                }
            } else if (result.status === 'skip') {
                skippedCount++;
            } else if (result.status === 'error') {
                errors.push(`${result.groupId}: ${result.error}`);
            }
        }
    }
    
    // Update organization document with EfSummary changes
    if (!isDryRun && Object.keys(orgSummaryUpdate).length > 0) {
        try {
            const orgRef = db.doc(`organizations/${orgId}`);
            await orgRef.set(orgSummaryUpdate as any, { merge: true });
            logger.info('backfillPlantJobData: updated org summary', { orgId, updateCount: Object.keys(orgSummaryUpdate).length });
        } catch (e: any) {
            logger.warn('backfillPlantJobData: failed to update org summary', {
                orgId,
                error: e?.message || String(e)
            });
        }
    }
    
    // Create backfill status document
    if (!isDryRun) {
        try {
            const statusRef = db.doc(`organizations/${orgId}/plantJobBackfillStatus/latest`);
            await statusRef.set({
                completedAt: Timestamp.now(),
                completedBy: uid,
                totalGroups: targetGroupIds.length,
                processedCount,
                updatedCount,
                skippedCount,
                flaggedForReviewCount,
                errorCount: errors.length,
                errors: errors.slice(0, 10) // Store first 10 errors
            });
        } catch (e: any) {
            logger.warn('backfillPlantJobData: failed to create status doc', {
                orgId,
                error: e?.message || String(e)
            });
        }
    }
    
    logger.info('backfillPlantJobData: completed', {
        orgId,
        isDryRun,
        processedCount,
        updatedCount,
        skippedCount,
        flaggedForReviewCount,
        errorCount: errors.length
    });
    
    return {
        ok: errors.length === 0,
        dryRun: isDryRun,
        totalGroups: targetGroupIds.length,
        processedCount,
        updatedCount,
        skippedCount,
        flaggedForReviewCount,
        errorCount: errors.length,
        errors: errors.slice(0, 10), // Return first 10 errors
        message: isDryRun 
            ? `Dry run completed. Would update ${updatedCount} groups (${flaggedForReviewCount} flagged for review)`
            : `Updated ${updatedCount} groups (${flaggedForReviewCount} flagged for review)`
    };
});

/**
 * Get backfill status for an organization
 */
export const getPlantJobBackfillStatus = onCall(async (request) => {
    const { orgId } = request.data || {};
    
    if (!orgId || typeof orgId !== 'string') {
        throw new HttpsError('invalid-argument', 'orgId required');
    }
    
    const db = getFirestore();
    const statusRef = db.doc(`organizations/${orgId}/plantJobBackfillStatus/latest`);
    const statusDoc = await statusRef.get();
    
    if (!statusDoc.exists) {
        return {
            hasRun: false,
            message: 'Backfill has not been run for this organization'
        };
    }
    
    return {
        hasRun: true,
        ...statusDoc.data()
    };
});

/**
 * List exposure groups flagged for review
 */
export const listPlantJobReviewCandidates = onCall(async (request) => {
    const { orgId, limit = 100 } = request.data || {};
    
    if (!orgId || typeof orgId !== 'string') {
        throw new HttpsError('invalid-argument', 'orgId required');
    }
    
    const db = getFirestore();
    const snapshot = await db.collection(`organizations/${orgId}/exposureGroups`)
        .where('plantJobNeedsReview', '==', true)
        .limit(Math.min(limit, 500))
        .get();
    
    const candidates: any[] = [];
    snapshot.forEach(doc => {
        const data = doc.data();
        candidates.push({
            groupId: doc.id,
            exposureGroup: data?.ExposureGroup || data?.Group,
            plantName: data?.plantName,
            jobName: data?.jobName,
            plantKey: data?.plantKey,
            jobKey: data?.jobKey
        });
    });
    
    return {
        count: candidates.length,
        candidates
    };
});
