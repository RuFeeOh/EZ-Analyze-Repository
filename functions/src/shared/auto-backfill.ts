/**
 * Automatic Plant/Job Backfill
 * 
 * This module provides automatic backfill functionality that runs on a schedule
 * or can be triggered manually to populate plant/job data for all organizations.
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { PlantJobExtractor } from "./plant-job-extraction";

/**
 * Scheduled function that automatically backfills plant/job data
 * Runs once per day to check for organizations that need backfilling
 */
export const autoBackfillPlantJob = onSchedule({
    schedule: "0 2 * * *", // Run daily at 2 AM UTC
    timeoutSeconds: 540,
    memory: "1GiB"
}, async (event) => {
    logger.info('autoBackfillPlantJob: starting scheduled backfill');
    
    const db = getFirestore();
    const systemUid = 'system-auto-backfill';
    
    try {
        // Get all organizations
        const orgsSnapshot = await db.collection('organizations').get();
        
        let totalOrgs = 0;
        let processedOrgs = 0;
        let skippedOrgs = 0;
        let errorOrgs = 0;
        
        for (const orgDoc of orgsSnapshot.docs) {
            const orgId = orgDoc.id;
            totalOrgs++;
            
            try {
                // Check if backfill has been run for this org
                const statusDoc = await db.doc(`organizations/${orgId}/plantJobBackfillStatus/latest`).get();
                
                if (statusDoc.exists) {
                    // Already backfilled, skip
                    skippedOrgs++;
                    logger.info('autoBackfillPlantJob: org already backfilled', { orgId });
                    continue;
                }
                
                // Check if org has any exposure groups
                const groupsSnapshot = await db.collection(`organizations/${orgId}/exposureGroups`)
                    .limit(1)
                    .get();
                
                if (groupsSnapshot.empty) {
                    skippedOrgs++;
                    logger.info('autoBackfillPlantJob: org has no exposure groups', { orgId });
                    continue;
                }
                
                // Run backfill for this org
                logger.info('autoBackfillPlantJob: processing org', { orgId });
                await backfillOrgPlantJob(db, orgId, systemUid);
                processedOrgs++;
                
                // Add delay to avoid overwhelming Firestore
                await new Promise(resolve => setTimeout(resolve, 2000));
                
            } catch (e: any) {
                errorOrgs++;
                logger.error('autoBackfillPlantJob: failed to process org', {
                    orgId,
                    error: e?.message || String(e)
                });
            }
        }
        
        logger.info('autoBackfillPlantJob: completed', {
            totalOrgs,
            processedOrgs,
            skippedOrgs,
            errorOrgs
        });
        
    } catch (e: any) {
        logger.error('autoBackfillPlantJob: failed', {
            error: e?.message || String(e)
        });
        throw e;
    }
});

/**
 * Manually trigger auto-backfill for all organizations
 */
export const triggerAutoBackfill = onCall(async (request) => {
    const uid = request.auth?.uid || 'system';
    
    logger.info('triggerAutoBackfill: starting manual trigger', { uid });
    
    const db = getFirestore();
    
    // Get all organizations
    const orgsSnapshot = await db.collection('organizations').get();
    
    const results = [];
    
    for (const orgDoc of orgsSnapshot.docs) {
        const orgId = orgDoc.id;
        
        try {
            // Check if backfill needed
            const statusDoc = await db.doc(`organizations/${orgId}/plantJobBackfillStatus/latest`).get();
            
            if (statusDoc.exists) {
                results.push({ orgId, status: 'skipped', reason: 'already-backfilled' });
                continue;
            }
            
            // Check if org has any exposure groups
            const groupsSnapshot = await db.collection(`organizations/${orgId}/exposureGroups`)
                .limit(1)
                .get();
            
            if (groupsSnapshot.empty) {
                results.push({ orgId, status: 'skipped', reason: 'no-groups' });
                continue;
            }
            
            // Run backfill
            await backfillOrgPlantJob(db, orgId, uid);
            results.push({ orgId, status: 'success' });
            
            // Add delay
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (e: any) {
            results.push({ 
                orgId, 
                status: 'error', 
                error: e?.message || String(e) 
            });
        }
    }
    
    return {
        ok: true,
        totalOrgs: orgsSnapshot.size,
        results
    };
});

/**
 * Backfill plant/job data for a single organization
 */
async function backfillOrgPlantJob(
    db: FirebaseFirestore.Firestore,
    orgId: string,
    uid: string
): Promise<void> {
    
    // Load existing exposure group names
    const existingNames: string[] = [];
    const allGroupsSnapshot = await db.collection(`organizations/${orgId}/exposureGroups`)
        .select('ExposureGroup', 'Group')
        .get();
    
    allGroupsSnapshot.forEach(doc => {
        const data = doc.data();
        const name = data?.ExposureGroup || data?.Group;
        if (name && typeof name === 'string') {
            existingNames.push(name);
        }
    });
    
    if (existingNames.length === 0) {
        return;
    }
    
    // Initialize extractor
    const extractor = new PlantJobExtractor(existingNames);
    
    // Process all groups
    let updatedCount = 0;
    let flaggedCount = 0;
    const errors: string[] = [];
    const orgSummaryUpdate: Record<string, any> = {};
    
    for (const doc of allGroupsSnapshot.docs) {
        try {
            const data = doc.data() as any;
            const exposureGroupName = data?.ExposureGroup || data?.Group || '';
            
            if (!exposureGroupName) {
                continue;
            }
            
            // Extract plant/job
            const extraction = extractor.extract(exposureGroupName);
            
            // Update the exposure group document
            const payload: any = {
                plantName: extraction.plantName,
                jobName: extraction.jobName,
                plantKey: extraction.plantKey,
                jobKey: extraction.jobKey,
                plantJobNeedsReview: extraction.plantJobNeedsReview,
                updatedAt: Timestamp.now(),
                updatedBy: uid
            };
            
            await doc.ref.set(payload, { merge: true });
            updatedCount++;
            
            if (extraction.plantJobNeedsReview) {
                flaggedCount++;
            }
            
            // Update org-level EfSummary if exists
            const groupId = doc.id;
            if (data?.LatestExceedanceFraction) {
                orgSummaryUpdate[`EfSummary.${groupId}.plantName`] = extraction.plantName;
                orgSummaryUpdate[`EfSummary.${groupId}.jobName`] = extraction.jobName;
                orgSummaryUpdate[`EfSummary.${groupId}.plantKey`] = extraction.plantKey;
                orgSummaryUpdate[`EfSummary.${groupId}.jobKey`] = extraction.jobKey;
                orgSummaryUpdate[`EfSummary.${groupId}.plantJobNeedsReview`] = extraction.plantJobNeedsReview;
            }
            
        } catch (e: any) {
            errors.push(`${doc.id}: ${e?.message || String(e)}`);
        }
    }
    
    // Update organization document with EfSummary changes
    if (Object.keys(orgSummaryUpdate).length > 0) {
        try {
            const orgRef = db.doc(`organizations/${orgId}`);
            await orgRef.set(orgSummaryUpdate as any, { merge: true });
        } catch (e: any) {
            logger.warn('backfillOrgPlantJob: failed to update org summary', {
                orgId,
                error: e?.message || String(e)
            });
        }
    }
    
    // Create backfill status document
    try {
        const statusRef = db.doc(`organizations/${orgId}/plantJobBackfillStatus/latest`);
        await statusRef.set({
            completedAt: Timestamp.now(),
            completedBy: uid,
            totalGroups: existingNames.length,
            updatedCount,
            flaggedForReviewCount: flaggedCount,
            errorCount: errors.length,
            errors: errors.slice(0, 10),
            autoBackfill: true
        });
    } catch (e: any) {
        logger.warn('backfillOrgPlantJob: failed to create status doc', {
            orgId,
            error: e?.message || String(e)
        });
    }
    
    logger.info('backfillOrgPlantJob: completed', {
        orgId,
        updatedCount,
        flaggedCount,
        errorCount: errors.length
    });
}
