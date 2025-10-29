import * as logger from "firebase-functions/logger";
import { Timestamp } from 'firebase-admin/firestore';

import * as admin from "firebase-admin";
import { SampleGroupIn } from "../models/sample-group-in.model";


export async function startJobTracking(jobRef: admin.firestore.DocumentReference<admin.firestore.DocumentData, admin.firestore.DocumentData>, totalGroupsProvided: any, groups: any[], totalRowsProvided: any, uid: string) {
    try {
        const snap = await jobRef.get();
        if (!snap.exists) {
            const totalGroupsAll = typeof totalGroupsProvided === 'number' ? totalGroupsProvided : (groups as SampleGroupIn[]).length;
            const totalRowsAll = typeof totalRowsProvided === 'number' ? totalRowsProvided : (groups as SampleGroupIn[]).reduce((sum, g) => sum + (g.samples?.length || 0), 0);
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

export async function finalizeJobStatus(db: admin.firestore.Firestore, jobRef: admin.firestore.DocumentReference<admin.firestore.DocumentData, admin.firestore.DocumentData>, orgId: any, jobId: string) {
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