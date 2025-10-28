
import { getFirestore } from 'firebase-admin/firestore';
import { Agent } from '../models/agent.model';
import { AgentNormalization } from '../models/agent-normalization.model';



export async function loadAgents(orgId: string): Promise<Agent[]> {
    if (!orgId) return [];
    const db = getFirestore();
    const snapshot = await db.collection(`organizations/${orgId}/agents`).get();
    return snapshot.docs.map(doc => {
        const data = doc.data() || {};
        return {
            Uid: doc.id,
            Name: typeof data.Name === 'string' ? data.Name : 'Unknown',
            Aliases: Array.isArray(data.Aliases) ? data.Aliases : [],
            OELNumber: typeof data.OELNumber === 'number' ? data.OELNumber : null,
            createdAt: data.createdAt,
            createdBy: data.createdBy,
            updatedAt: data.updatedAt,
            updatedBy: data.updatedBy,
        } as Agent;
    });
    // const directory: Agent[] = [];
    // snapshot.forEach(doc => {
    //     const data = (doc.data() || {}) as any;
    //     const rawName = typeof data.Name === 'string' ? data.Name.trim() : '';
    //     const baseName = rawName || doc.id || 'Unknown';
    //     const canonicalKey = slugifyAgent(typeof data.Uid === 'string' && data.Uid.trim() ? data.Uid : baseName);
    //     const record: ResolvedAgent = {
    //         key: canonicalKey || slugifyAgent(baseName) || 'unknown',
    //         name: baseName,
    //         oel: toPositiveNumber(data.OELNumber, DEFAULT_OEL),
    //     };
    //     const identifiers: Array<string | null | undefined> = [
    //         doc.id,
    //         baseName,
    //         data.Uid,
    //         data.AgentKey,
    //     ];
    //     if (Array.isArray(data.Aliases)) {
    //         for (const alias of data.Aliases) identifiers.push(alias);
    //     }
    //     identifiers.push(record.key);
    //     buildAgentDirectoryEntry(directory, record, identifiers);
    // });
    // return directory;
}

export function slugifyAgent(value: string): string {
    return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 120) || 'unknown';
}

export function normalizeAgent(raw: string | null | undefined): AgentNormalization {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return { key: 'unknown', name: 'Unknown' };
    return { key: slugifyAgent(value), name: value };
}