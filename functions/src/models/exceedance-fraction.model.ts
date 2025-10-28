import { SampleInfo } from "./sample-info.model";

export type ExceedanceFraction = {
    ExceedanceFraction: number;
    DateCalculated: string;
    OELNumber: number;
    MostRecentNumber: number;
    ResultsUsed: SampleInfo[];
    AgentKey?: string;
    AgentName?: string;
};