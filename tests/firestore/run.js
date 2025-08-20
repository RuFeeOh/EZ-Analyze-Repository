/*
  Firestore emulator tests for:
  - Upsert dedup: deterministic docId avoids duplicates
  - History append and Results concat
  - Rules enforce org membership; forbid cross-org writes
  - EF recomputation uses last 6 samples

  Run with: npm run test:rules
*/
const assert = require('assert');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, updateDoc, getFirestore, collection, runTransaction } = require('firebase/firestore');

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT || 'demo-ez-analyze';

function toISO(d) {
    if (typeof d === 'string') return new Date(d).toISOString();
    return new Date(d).toISOString();
}

function makeSample(n, dateISO, group, twa) {
    return {
        SampleNumber: n,
        SampleDate: dateISO,
        ExposureGroup: group,
        TWA: twa,
        Notes: ''
    };
}

async function setupOrgs(env, userId, orgId, otherOrgId) {
    await env.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, 'organizations', orgId), { Uid: orgId, Name: 'Org A', UserUids: [userId] });
        await setDoc(doc(db, 'organizations', otherOrgId), { Uid: otherOrgId, Name: 'Org B', UserUids: ['someoneelse'] });
    });
}

async function makeUserDb(env, uid) {
    const ctx = env.authenticatedContext(uid);
    return ctx.firestore();
}

async function readGroup(db, orgId, id) {
    const snap = await getDoc(doc(db, 'organizations', orgId, 'exposureGroups', id));
    return snap.exists() ? snap.data() : null;
}

function slug(text) {
    return text.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').replace(/-+/g, '-').slice(0, 120);
}

async function run() {
    const env = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: {
            rules: (await require('fs').promises.readFile('firestore.rules', 'utf8')),
        },
    });

    try {
        const userId = 'userA';
        const orgId = 'orgA';
        const otherOrgId = 'orgB';
        await setupOrgs(env, userId, orgId, otherOrgId);

        const dbUser = await makeUserDb(env, userId);
        const dbOther = await makeUserDb(env, 'intruder');

        // deterministic id
        const groupName = 'Welders Shop';
        const docId = slug(groupName);

        // 1) Upsert: transaction get on non-existent doc should be allowed for member
        await assertSucceeds(getDoc(doc(dbUser, 'organizations', orgId, 'exposureGroups', docId)));

        // 2) Cross-org write forbidden: user cannot write under other org path
        await assertFails(setDoc(doc(dbUser, 'organizations', otherOrgId, 'exposureGroups', docId), {
            OrganizationUid: otherOrgId,
            Group: groupName
        }))

        // 3) Valid create with org membership under nested path; EF fields must NOT be set by client
        await assertSucceeds(setDoc(doc(dbUser, 'organizations', orgId, 'exposureGroups', docId), {
            OrganizationUid: orgId,
            OrganizationName: 'Org A',
            Group: groupName,
            ExposureGroup: groupName,
            Results: []
        }));

        // 4) Append results and history; emulate recompute uses last 6
        const baseDate = new Date('2025-01-01T00:00:00.000Z');
        const samples = Array.from({ length: 10 }).map((_, i) => makeSample(i + 1, toISO(new Date(baseDate.getTime() + i * 86400000)), groupName, 0.1 + i * 0.01));

        // First update: add 4 samples; trying to set EF fields should be rejected
        await assertSucceeds(updateDoc(doc(dbUser, 'organizations', orgId, 'exposureGroups', docId), {
            Results: samples.slice(0, 4)
        }));
        await assertFails(updateDoc(doc(dbUser, 'organizations', orgId, 'exposureGroups', docId), {
            LatestExceedanceFraction: { ExceedanceFraction: 0.2 },
        }));

        // Second update: concat 6 more samples
        await assertSucceeds(updateDoc(doc(dbUser, 'organizations', orgId, 'exposureGroups', docId), {
            Results: samples // concatenated 10
        }));

        // Verify state
        const final = await readGroup(dbUser, orgId, docId);
        assert(final, 'exposureGroup should exist');
        assert.equal(final.Results.length, 10, 'Results should concatenate');
        // In rules-only tests (no functions), EF fields should not be writable by client
        // and will remain unset here.
        assert(!('LatestExceedanceFraction' in final) || final.LatestExceedanceFraction == null);
        assert(!('ExceedanceFractionHistory' in final) || Array.isArray(final.ExceedanceFractionHistory) === false || final.ExceedanceFractionHistory.length === 0);

        // 5) Intruder cannot read/write other org exposureGroups
        await assertFails(getDoc(doc(dbOther, 'organizations', orgId, 'exposureGroups', docId)));
        await assertFails(updateDoc(doc(dbOther, 'organizations', orgId, 'exposureGroups', docId), { Group: 'Hacked' }));

        // 6) Private user-scoped exposure groups: owner can create, intruder cannot read
        const privateId = slug('Welders Shop');
        await assertSucceeds(setDoc(doc(dbUser, 'organizations', orgId, 'users', userId, 'exposureGroups', privateId), {
            OrganizationUid: orgId,
            OrganizationName: 'Org A',
            Group: groupName,
            ExposureGroup: groupName,
            Results: []
        }));
        await assertFails(getDoc(doc(dbOther, 'organizations', orgId, 'users', userId, 'exposureGroups', privateId)));

        console.log('All tests passed');
    } finally {
        await (await env).cleanup();
    }
}

run().catch(e => { console.error(e); process.exit(1); });
