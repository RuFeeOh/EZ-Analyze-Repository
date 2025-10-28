import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';



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
