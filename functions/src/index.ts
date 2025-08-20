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

export const recomputeExceedanceFraction = onDocumentWritten("exposureGroups/{docId}", async (event) => {
    const before = event.data?.before?.data() as any | undefined;
    const after = event.data?.after?.data() as any | undefined;
    const docId = event.params.docId as string;
    if (!after) return; // deleted

    // Only recompute when Results changed or EF fields missing
    const beforeResultsStr = JSON.stringify(before?.Results || []);
    const afterResultsStr = JSON.stringify(after.Results || []);
    const efMissing = !after.LatestExceedanceFraction || !Array.isArray(after.ExceedanceFractionHistory);
    if (!efMissing && beforeResultsStr === afterResultsStr) {
        return;
    }

    const db = admin.firestore();
    const ref = db.doc(`exposureGroups/${docId}`);

    await db.runTransaction(async (tx) => {
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

    logger.info(`Recomputed EF for exposureGroups/${docId}`);
});
