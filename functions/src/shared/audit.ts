import * as logger from "firebase-functions/logger";
import { getFirestore } from 'firebase-admin/firestore';

import { AuditLogRecord } from "../models/audit-log-record.model";
import { AgentEfSnapshot } from "../models/agent-ef-snapshot.model";
import { compactEfSnapshot } from "./ef";




export async function appendAuditRecords(orgId: string, entries: AuditLogRecord[]): Promise<void> {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const db = getFirestore();
    const chunkSize = 25;
    for (let i = 0; i < entries.length; i += chunkSize) {
        const chunk = entries.slice(i, i + chunkSize);
        await Promise.all(chunk.map(async (entry) => {
            try {
                await db.collection(`organizations/${orgId}/auditLogs`).add({
                    orgId,
                    ...entry,
                    metadata: entry.metadata || {},
                    before: entry.before ?? null,
                    after: entry.after ?? null,
                });
            } catch (e: any) {
                logger.warn('appendAuditRecords failed', { orgId, error: e?.message || String(e) });
            }
        }));
    }
}

export function compactLatestMapForAudit(map: Record<string, AgentEfSnapshot> | undefined): Record<string, any> {
    if (!map || typeof map !== 'object') return {};
    const out: Record<string, any> = {};
    for (const [key, snapshot] of Object.entries(map)) {
        const compact = compactEfSnapshot(snapshot);
        if (compact) out[key] = compact;
    }
    return out;
}
