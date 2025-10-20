import { SampleInfo } from "./sample-info.model";

export class ExceedanceFraction {
    uid: string = "";
    ExceedanceFraction: number = 0;
    DateCalculated: string = new Date().toISOString();
    MostRecentNumber: number = 6;
    OELNumber: number = 0.05;
    ResultsUsed: SampleInfo[] = [];
    AgentKey?: string;
    AgentName?: string;
    constructor(partial: Partial<ExceedanceFraction> = {}) {
        Object.assign(this, partial);
    }
}