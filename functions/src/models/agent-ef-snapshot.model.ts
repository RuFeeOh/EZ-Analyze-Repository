import { ExceedanceFraction } from "./exceedance-fraction.model";

export type AgentEfSnapshot = ExceedanceFraction & { AgentKey: string; AgentName: string };
