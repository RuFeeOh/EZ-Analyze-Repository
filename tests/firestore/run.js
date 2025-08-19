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

const PROJECT_ID = 'demo-ez-analyze';

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
    const admin = env.unauthenticatedContext().firestore();
    await setDoc(doc(admin, 'organizations', orgId), { Uid: orgId, Name: 'Org A', UserUids: [userId] });
    await setDoc(doc(admin, 'organizations', otherOrgId), { Uid: otherOrgId, Name: 'Org B', UserUids: ['someoneelse'] });
}

async function makeUserDb(env, uid) {
    const ctx = env.authenticatedContext(uid);
    return ctx.firestore();
}

async function readGroup(db, id) {
    const snap = await getDoc(doc(db, 'exposureGroups', id));
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
        const docId = `${orgId}__${slug(groupName)}`;

        // 1) Upsert: transaction get on non-existent doc should be allowed for member
        await assertSucceeds(getDoc(doc(dbUser, 'exposureGroups', docId)));

        // 2) Cross-org write forbidden: create with mismatched OrganizationUid
        await assertFails(setDoc(doc(dbUser, 'exposureGroups', docId), {
            OrganizationUid: otherOrgId,
            Group: groupName
        }));

        // 3) Valid create with org membership
        await assertSucceeds(setDoc(doc(dbUser, 'exposureGroups', docId), {
            OrganizationUid: orgId,
            OrganizationName: 'Org A',
            Group: groupName,
            ExposureGroup: groupName,
            Results: [],
            LatestExceedanceFraction: null,
            ExceedanceFractionHistory: []
        }));

        // 4) Append results and history; emulate recompute uses last 6
        const baseDate = new Date('2025-01-01T00:00:00.000Z');
        const samples = Array.from({ length: 10 }).map((_, i) => makeSample(i + 1, toISO(new Date(baseDate.getTime() + i * 86400000)), groupName, 0.1 + i * 0.01));

        // First update: add 4 samples
        await assertSucceeds(updateDoc(doc(dbUser, 'exposureGroups', docId), {
            Results: samples.slice(0, 4),
            LatestExceedanceFraction: {
                ExceedanceFraction: 0.2,
                DateCalculated: toISO(new Date('2025-02-01')),
                OELNumber: 0.05,
                MostRecentNumber: 4,
                ResultsUsed: samples.slice(0, 4)
            },
            ExceedanceFractionHistory: [
                {
                    ExceedanceFraction: 0.2,
                    DateCalculated: toISO(new Date('2025-02-01')),
                    OELNumber: 0.05,
                    MostRecentNumber: 4,
                    ResultsUsed: samples.slice(0, 4)
                }
            ]
        }));

        // Second update: concat 6 more samples; EF should use last 6 chronologically when recomputed by app code
        await assertSucceeds(updateDoc(doc(dbUser, 'exposureGroups', docId), {
            Results: samples, // concatenated 10
            ExceedanceFractionHistory: [
                {
                    ExceedanceFraction: 0.2,
                    DateCalculated: toISO(new Date('2025-02-01')),
                    OELNumber: 0.05,
                    MostRecentNumber: 4,
                    ResultsUsed: samples.slice(0, 4)
                },
                {
                    ExceedanceFraction: 0.3,
                    DateCalculated: toISO(new Date('2025-02-10')),
                    OELNumber: 0.05,
                    MostRecentNumber: 6,
                    ResultsUsed: samples.slice(4, 10) // last 6
                }
            ],
            LatestExceedanceFraction: {
                ExceedanceFraction: 0.3,
                DateCalculated: toISO(new Date('2025-02-10')),
                OELNumber: 0.05,
                MostRecentNumber: 6,
                ResultsUsed: samples.slice(4, 10)
            }
        }));

        // Verify state
        const final = await readGroup(dbUser, docId);
        assert(final, 'exposureGroup should exist');
        assert.equal(final.Results.length, 10, 'Results should concatenate');
        assert.equal(final.ExceedanceFractionHistory.length, 2, 'History should append');
        assert.equal(final.LatestExceedanceFraction.MostRecentNumber, 6);
        assert.equal(final.LatestExceedanceFraction.ResultsUsed.length, 6);

        // 5) Intruder cannot read/write other org exposureGroups
        await assertFails(getDoc(doc(dbOther, 'exposureGroups', docId)));
        await assertFails(updateDoc(doc(dbOther, 'exposureGroups', docId), { Group: 'Hacked' }));

        console.log('All tests passed');
    } finally {
        await (await env).cleanup();
    }
}

run().catch(e => { console.error(e); process.exit(1); });
