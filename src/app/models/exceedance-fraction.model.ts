import { ExposureGroupResult } from "./exposure-group-result.model";

export class ExceedanceFraction {
    uid: string = "";
    ExceedanceFraction: number = 0;
    DateCalculated: string = new Date().toISOString();
    MostRecentNumber: number = 6;
    OELNumber: number = 0.05;
    ResultsUsed: ExposureGroupResult[] = [];
    constructor(partial: Partial<ExceedanceFraction> = {}) {
        Object.assign(this, partial);
    }
}