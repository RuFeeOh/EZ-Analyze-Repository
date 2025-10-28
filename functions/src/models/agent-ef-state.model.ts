import { AgentEfSnapshot } from "./agent-ef-snapshot.model";

export interface AgentEfState {
    latestByAgent: Record<string, AgentEfSnapshot>;
    historyByAgent: Record<string, AgentEfSnapshot[]>;
    topSnapshot: AgentEfSnapshot | null;
    topAgentKey: string | null;
    changedAgentKeys: Set<string>;
    removedAgentKeys: Set<string>;
}