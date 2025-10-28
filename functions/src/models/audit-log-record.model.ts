export type AuditLogRecord = {
    type: 'bulk-import' | 'agent-removal' | 'undo-import';
    at: FirebaseFirestore.Timestamp;
    actorUid: string;
    groupId?: string;
    jobId?: string | null;
    metadata?: Record<string, any>;
    before?: any;
    after?: any;
};