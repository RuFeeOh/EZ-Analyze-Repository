// AIHA Rating calculation

import { SampleInfo } from "../models/sample-info.model";

/**
 * AIHA exposure rating categories
 */
export enum AIHARating {
    INVALID = 0,     // Invalid or insufficient data
    CATEGORY_1 = 1,  // <10% of OEL
    CATEGORY_2 = 2,  // >=10% <50% of OEL
    CATEGORY_3 = 3,  // >=50% <100% of OEL
    CATEGORY_4 = 4   // >=100% of OEL
}

/**
 * Calculate the 95th percentile from an array of measurements
 * @param measurements Array of TWA values
 * @returns 95th percentile value
 */
export function calculate95thPercentile(measurements: number[]): number {
    if (!measurements || measurements.length === 0) {
        return 0;
    }

    // If only one measurement, use it as the 95th percentile
    if (measurements.length === 1) {
        return measurements[0];
    }

    // For lognormal distribution, calculate 95th percentile
    const logMeasurements = measurements.map(x => Math.log(x));
    const mean = logMeasurements.reduce((sum, val) => sum + val, 0) / logMeasurements.length;
    const variance = logMeasurements.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (logMeasurements.length - 1);
    const stdDev = Math.sqrt(variance);

    // 95th percentile z-score is 1.645
    const zScore95 = 1.645;
    const log95thPercentile = mean + (zScore95 * stdDev);
    const percentile95 = Math.exp(log95thPercentile);

    return percentile95;
}

/**
 * Calculate AIHA exposure rating category based on 95th percentile and OEL
 * Categories:
 * 1 - <10%
 * 2 - >=10% <50%
 * 3 - >=50% <100%
 * 4 - >=100%
 * 
 * @param ninetyFifthPercentile The 95th percentile value
 * @param OEL The Occupational Exposure Limit
 * @returns AIHA category enum
 */
export function calculateAIHARating(ninetyFifthPercentile: number, OEL: number): AIHARating {
    if (!OEL || OEL === 0) {
        return AIHARating.INVALID; // Invalid OEL
    }

    const ratio = ninetyFifthPercentile / OEL;

    if (ratio < 0.10) {
        return AIHARating.CATEGORY_1;
    } else if (ratio < 0.50) {
        return AIHARating.CATEGORY_2;
    } else if (ratio < 1.00) {
        return AIHARating.CATEGORY_3;
    } else {
        return AIHARating.CATEGORY_4;
    }
}

/**
 * Get AIHA rating from sample results
 * @param results Array of sample results (most recent 6)
 * @param OEL Occupational Exposure Limit
 * @returns Object with 95th percentile, ratio, and AIHA rating enum
 */
export function getAIHARatingFromSamples(results: SampleInfo[], OEL: number): {
    ninetyFifthPercentile: number;
    ratio: number;
    aihaRating: AIHARating;
} {
    const measurements = results
        .map(r => r.TWA)
        .filter((twa): twa is number => typeof twa === 'number' && !isNaN(twa) && twa > 0);

    if (measurements.length === 0) {
        return {
            ninetyFifthPercentile: 0,
            ratio: 0,
            aihaRating: AIHARating.INVALID
        };
    }

    const ninetyFifthPercentile = calculate95thPercentile(measurements);
    const ratio = OEL > 0 ? ninetyFifthPercentile / OEL : 0;
    const aihaRating = calculateAIHARating(ninetyFifthPercentile, OEL);

    return {
        ninetyFifthPercentile,
        ratio,
        aihaRating
    };
}
