# Practical options (from light to robust)

## Metadata on each document (baseline)
**What:** Add createdAt/createdBy and updatedAt/updatedBy fields to every write.

**How:**
Enforce via Security Rules: require `createdBy == request.auth.uid` on create, `updatedBy == request.auth.uid` on update; require `updatedAt == request.time`.
Use Firestore `serverTimestamp` or set by Cloud Functions.

**Pros:** Simple, zero extra collections, cheap.

**Cons:** No historical trail—only “who/when last touched.”

## Firestore audit subcollection via Cloud Functions (recommended for your app)
**What:** Use `onDocumentWritten` triggers to write a compact audit log entry per change.

**Where:** For your org data, something like `organizations/{orgId}/auditLogs/{autoId}`.

**What to store per entry:**
timestamp, actorUid (copied from the doc’s updatedBy field validated by rules), action (create/update/delete), documentPath, docId, collection, source (ui/batch/function), batchId if applicable.
diff of changed fields (prefer over entire before/after to keep size down).

**Space control:**
Use Firestore TTL to auto-expire logs after your retention (e.g., 365 days).
Optionally export older logs to Cloud Storage/BigQuery for long-term retention.

**Pros:** Full history, tied to your org structure, easy to show “History” in the UI.

**Cons:** Some extra write cost/storage; you must design the log schema.

## Firestore → BigQuery change stream (extension/streaming)
**What:** Use the official “Export Collections to BigQuery” Firebase Extension (or Change Streams → Dataflow template) to stream change logs into BigQuery tables (raw changelog + latest snapshot).

**Pros:** Practically unlimited retention and rich querying (who changed what over time, diffs). Great for compliance/reporting.

**Cons:** Added infra and cost (BigQuery + streaming). More suited when audit queries get heavy or long retention is required.

## Point-in-time recovery (PITR) for safety, not auditing
Firestore offers PITR to roll back to a previous moment after accidental data loss/corruption.

**Pros:** Disaster recovery.

**Cons:** Not a user-facing audit trail; not “who changed what.”

## Cloud Audit Logs (admin activity)
GCP logs admin/API actions (project-level), useful for ops/security.

**Cons:** Doesn’t include document contents/diffs; not a substitute for a per-doc audit timeline.

## What I recommend for you now
Implement Option 2 (audit subcollection) with Option 1 (metadata) immediately, and keep the door open for Option 3 later if you want analytics on the logs over long retention.

## Minimal design that works well
### Security Rules:
On create: require `request.resource.data.createdBy == request.auth.uid` and `createdAt == request.time`.
On update: require `request.resource.data.updatedBy == request.auth.uid` and `updatedAt == request.time`.
Prevent changing createdBy/createdAt after creation.

### Cloud Function (`onDocumentWritten`) on the collections you care about (exposureGroups, results, agents):
Read before/after, compute a concise diff (changed fields + new values, plus deleted flags).
Read actorUid from after.updatedBy (or before for deletes).
Write audit doc under `organizations/{orgId}/auditLogs` with TTL field `expireAt = now + retention` (e.g., 365 days).
Include batchId, source, clientVersion if you have them—very useful in investigations.

### UI:
Add a “History” panel on exposure group details that lists last N audit entries with pretty diffs and “who/when”.

### Retention:
Configure Firestore TTL on `auditLogs.expireAt` so logs auto-prune.
Add a scheduled export to GCS or BigQuery (optional) if you need longer retention or ad‑hoc queries.

## Sample snippets to guide implementation
### Security Rules sketch

Enforce metadata is set properly and immutable after creation.
Example condition on update:

```
request.resource.data.updatedBy == request.auth.uid
request.resource.data.updatedAt == request.time
resource.data.createdBy == request.resource.data.createdBy
```

### Audit doc shape

path, orgId, collection, docId, action, actorUid, at, diff, batchId?, source?, clientVersion?, ip? (IP only if routed via backend; don’t capture IP from client directly for privacy).

### Diff strategy

Only store changed keys:

```
changed: { fieldA: { before: 1, after: 2 }, fieldB: { before: 'x', after: 'y' } }
removed: ['obsoleteField']
added: ['newField']
```

This keeps entries small and readable.

## Cost and scale notes
Firestore writes: Each change generates one extra write to auditLogs; with TTL, storage stays bounded by retention × write rate.
Query patterns: Keep auditLogs under each org to avoid cross-org fanout. Index by documentPath or docId if you want quick per-doc history.
BigQuery path: If later you need complex across-org queries or long retention, install the extension and stream logs into BigQuery. You can keep Firestore audit for UI and use BigQuery for compliance analytics.

## Offer to implement
If you want, I can:

Add the Security Rules to enforce created/updated metadata.
Add an auditLogs write trigger similar to your EF trigger.
Introduce TTL on audit logs and a small diff helper.
Add a “History” tab on the exposure group page to display diffs.
Tell me your desired retention period (e.g., 180/365/730 days) and whether you want a BigQuery sink now or later, and I’ll wire it up.