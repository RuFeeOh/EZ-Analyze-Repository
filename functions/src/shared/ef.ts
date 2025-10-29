// ef = exceedance fraction


import { Agent } from "../models/agent.model";
import { ExceedanceFraction } from "../models/exceedance-fraction.model";
import { SampleInfo } from "../models/sample-info.model";
import { slugifyAgent } from "./agent";
import { compactResults } from "./results";

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
export function calculateExceedanceProbability(measurements: number[], OEL: number): number {
    const logMeasurements = measurements.map(x => Math.log(x));
    const mean = logMeasurements.reduce((sum, val) => sum + val, 0) / logMeasurements.length;
    const variance = logMeasurements.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (logMeasurements.length - 1);
    const stdDev = Math.sqrt(variance);
    const logOEL = Math.log(OEL);
    const zScore = (logOEL - mean) / stdDev;
    const exceedanceProbability = 1 - normalCDF(zScore);
    return exceedanceProbability;
}

export function createExceedanceFraction(
    exceedanceFraction: number,
    resultsUsed: SampleInfo[],
    TWAlist: number[],
    agent: Agent
): ExceedanceFraction {
    return {
        ExceedanceFraction: exceedanceFraction,
        DateCalculated: new Date().toISOString(),
        OELNumber: agent.OELNumber,
        MostRecentNumber: TWAlist.length,
        ResultsUsed: resultsUsed,
        AgentKey: slugifyAgent(agent.Name),
        AgentName: agent.Name,
    };
}


export function compactEfSnapshot(snapshot: any) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    return {
        ExceedanceFraction: typeof snapshot.ExceedanceFraction === 'number' ? snapshot.ExceedanceFraction : null,
        MostRecentNumber: typeof snapshot.MostRecentNumber === 'number' ? snapshot.MostRecentNumber : null,
        AgentKey: snapshot.AgentKey ?? null,
        AgentName: snapshot.AgentName ?? null,
        Results: compactResults(snapshot.ResultsUsed),
    };
}