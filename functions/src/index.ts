/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import Stripe from "stripe";

admin.initializeApp();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, { apiVersion: '2024-06-20' });

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
    if (!after) {
        logger.info(`EF trigger: document deleted, skipping: organizations/${event.params.orgId}/exposureGroups/${docId}`);
        return;
    }

    // Only recompute when Results changed or EF fields missing
    const beforeResultsStr = JSON.stringify(before?.Results || []);
    const afterResultsStr = JSON.stringify(after.Results || []);
    const efMissing = !after.LatestExceedanceFraction || !Array.isArray(after.ExceedanceFractionHistory);
    if (!efMissing && beforeResultsStr === afterResultsStr) {
        logger.info(`EF trigger: no change in Results and EF present, skipping for ${docId}`);
        return;
    }

    const db = admin.firestore();
    const orgId = event.params.orgId as string;
    const ref = db.doc(`organizations/${orgId}/exposureGroups/${docId}`);

    await db.runTransaction(async (tx: any) => {
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

    logger.info(`Recomputed EF for organizations/${event.params.orgId}/exposureGroups/${docId}`);
});

// Create a Checkout Session for a price and return the URL
export const createCheckoutSession = onRequest({ cors: true }, async (req, res) => {
    try {
        if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
        const { priceId, customerEmail, orgId } = req.body || {};
        if (!priceId) { res.status(400).json({ error: 'Missing priceId' }); return; }
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer_email: customerEmail,
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${req.headers.origin}/home?checkout=success`,
            cancel_url: `${req.headers.origin}/home?checkout=cancel`,
            metadata: { orgId: orgId || '' }
        });
        res.json({ url: session.url });
    } catch (e: any) {
        logger.error('createCheckoutSession failed', e);
        res.status(500).json({ error: e?.message || 'Internal error' });
    }
});

// Create a Billing Portal Session so users can manage subscriptions
export const createPortalSession = onRequest({ cors: true }, async (req, res) => {
    try {
        if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
        const { customerId } = req.body || {};
        if (!customerId) { res.status(400).json({ error: 'Missing customerId' }); return; }
        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${req.headers.origin}/home`
        });
        res.json({ url: session.url });
    } catch (e: any) {
        logger.error('createPortalSession failed', e);
        res.status(500).json({ error: e?.message || 'Internal error' });
    }
});

// Stripe webhook to update Firestore with subscription status
export const stripeWebhook = onRequest({ cors: true }, async (req, res) => {
    const sig = req.headers['stripe-signature'] as string | undefined;
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET as string | undefined;
    if (!endpointSecret) { res.status(500).send('Missing STRIPE_WEBHOOK_SECRET'); return; }
    try {
        const buf = (req as any).rawBody ? (req as any).rawBody as Buffer : Buffer.from(JSON.stringify(req.body));
        const event = stripe.webhooks.constructEvent(buf, sig!, endpointSecret);
        switch (event.type) {
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
            case 'customer.subscription.deleted': {
                const sub = event.data.object as Stripe.Subscription;
                const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
                const status = sub.status;
                // Store minimal subscription state under /billing/customers/{customerId}
                await admin.firestore().doc(`billing/customers/${customerId}`).set({ status, updatedAt: new Date().toISOString() }, { merge: true });
                break;
            }
            default:
                logger.info(`Unhandled event type ${event.type}`);
        }
        res.json({ received: true });
    } catch (err: any) {
        logger.error('Webhook error', err);
        res.status(400).send(`Webhook Error: ${err.message}`);
    }
});
