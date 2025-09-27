import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { AgentsDialogComponent } from './agents-dialog/agents-dialog.component';
import { ExceedanceFractionService } from '../../services/exceedance-fraction/exceedance-fraction.service';
import { ExposureGroupService } from '../../services/exposure-group/exposure-group.service';
import { EfRecomputeTrackerService } from '../../services/exceedance-fraction/ef-recompute-tracker.service';
import { OrganizationService } from '../../services/organization/organization.service';
import { Firestore } from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { Auth } from '@angular/fire/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { SnackService } from '../../services/ui/snack.service';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { BackgroundStatusService } from '../../services/background-status/background-status.service';
import { AgentService } from '../../services/agent/agent.service';
import { SampleInfo } from '../../models/sample-info.model';

interface SaveContext { validRows: SampleInfo[]; onProgress?: (done: number, total: number) => void; }

@Injectable({
    providedIn: 'root'
})
export class DataService {
    exceedanceFractionservice = inject(ExceedanceFractionService);
    exposureGroupservice = inject(ExposureGroupService);
    efTracker = inject(EfRecomputeTrackerService);
    organizationservice = inject(OrganizationService);
    private firestore = inject(Firestore);
    private auth = inject(Auth);
    private functions = inject(Functions);
    private snackBar = inject(SnackService);
    private agentService = inject(AgentService);
    private dialog = inject(MatDialog);
    private bg = inject(BackgroundStatusService);

    calculateExceedanceFraction(rows: SampleInfo[]): number {
        const TWAlist: number[] = this.exposureGroupservice.getTWAListFromSampleInfo(rows);
        return this.exceedanceFractionservice.calculateExceedanceProbability(TWAlist, 0.05);
    }

    async save(context: SaveContext) {
        const currentOrg = this.organizationservice.currentOrg;
        if (!currentOrg) { this.snackBar.open('Please select an organization before uploading.', 'Dismiss', { duration: 5000, verticalPosition: 'top' }); return; }
        const uid = this.auth.currentUser?.uid;
        if (!uid) { this.snackBar.open('Please sign in to save data.', 'Dismiss', { duration: 4000, verticalPosition: 'top' }); return; }


        const validRows = context.validRows;
        const allAgents = Array.from(new Set(validRows.map(r => (r.Agent || '').trim()).filter(a => !!a)));
        if (allAgents.length) {
            const orgId = currentOrg.Uid;
            let existing: Record<string, number> = {};
            try { const list$ = this.agentService.list(orgId); const list = await firstValueFrom(list$); existing = Object.fromEntries((list || []).map(a => [a.Name, a.OELNumber])); } catch { }
            const missing = allAgents.filter(a => existing[a] === undefined);
            if (missing.length) {
                try {
                    const dlgRef = this.dialog.open(AgentsDialogComponent, { data: { agents: missing, existing }, width: '520px' });
                    const result = await dlgRef.afterClosed().toPromise();
                    if (!result) { this.snackBar.open('Agent entry canceled.', 'Dismiss', { duration: 3000, verticalPosition: 'top' }); return; }
                    for (const row of result) {
                        if (!row?.Name) continue;
                        try { await this.agentService.upsert(orgId, { Name: row.Name, OELNumber: Number(row.OELNumber) }); } catch { }
                    }
                } catch { }
            }
        }
        const grouped = this.exposureGroupservice.separateSampleInfoByExposureGroup(validRows);
        const startIso = new Date().toISOString();
        const ids = Object.keys(grouped).map(name => this.slugify(name));
        const total = ids.length;
        const shouldWaitForEf = total > 0 && total <= 10; // wait only for small imports
        const uploadTaskId = this.bg.startTask({ label: 'Uploading results', detail: `${total} exposure group(s)`, kind: 'upload', total, indeterminate: true });
        let progressSnackRef: any = null;
        const progress$ = new BehaviorSubject<{ done: number; total: number }>({ done: 0, total });
        if (shouldWaitForEf) {
            try {
                const { ProgressSnackComponent } = await import('../../shared/progress-snack/progress-snack.component');
                progressSnackRef = this.snackBar.openFromComponent(ProgressSnackComponent, { data: { label: 'Recomputing EF…', progress$ } });
            } catch { }
        }
        try {
            // For large imports, offload to server BulkWriter for speed; for small, stay client-side
            if (total > 50) {
                const call = httpsCallable(this.functions as any, 'bulkImportResults');
                const groupsPayload = Object.entries(grouped).map(([groupName, samples]) => ({ groupName, samples }));
                // Chunk by rows and groups to avoid 10MB callable payload limits
                const chunkByRows = (items: any[], maxRowsPerBatch = 3500, maxGroupsPerBatch = 150) => {
                    const batches: any[][] = [];
                    let current: any[] = [];
                    let rows = 0;
                    for (const g of items) {
                        const c = (g.samples?.length || 0);
                        if (current.length && (rows + c > maxRowsPerBatch || current.length >= maxGroupsPerBatch)) {
                            batches.push(current);
                            current = [];
                            rows = 0;
                        }
                        current.push(g);
                        rows += c;
                    }
                    if (current.length) batches.push(current);
                    return batches;
                };
                const batches = chunkByRows(groupsPayload);
                const totalBatches = batches.length;
                const unsubscribers: Array<() => void> = [];
                const jobProgress: Record<string, { rows: number; totalRows: number; status?: string }> = {};
                const updateAggregateProgress = () => {
                    const rows = Object.values(jobProgress).reduce((s, v) => s + (v.rows || 0), 0);
                    const totalRows = Object.values(jobProgress).reduce((s, v) => s + (v.totalRows || 0), 0);
                    const completed = Object.values(jobProgress).filter(v => v.status === 'completed' || v.status === 'completed-with-errors' || v.status === 'failed').length;
                    this.bg.updateTask(uploadTaskId, { detail: `${rows}/${totalRows} rows • ${completed}/${totalBatches} batches`, indeterminate: totalRows ? false : true });
                };
                for (let i = 0; i < batches.length; i++) {
                    const batch = batches[i];
                    this.bg.updateTask(uploadTaskId, { detail: `Submitting batch ${i + 1}/${totalBatches}…` });
                    const resp: any = await call({ orgId: currentOrg.Uid, organizationName: currentOrg.Name, groups: batch });
                    const jobId = resp?.data?.jobId as string | undefined;
                    if (jobId) {
                        const jobDoc = doc(this.firestore as any, `organizations/${currentOrg.Uid}/importJobs/${jobId}`);
                        const { onSnapshot } = await import('firebase/firestore');
                        const unsub = onSnapshot(jobDoc as any, (snap: any) => {
                            const d = (snap?.data?.() || {}) as any;
                            jobProgress[jobId] = { rows: d.rowsWritten || 0, totalRows: d.totalRows || 0, status: d.status };
                            updateAggregateProgress();
                        }, (err: any) => {
                            // If permission denied for job doc, keep going
                            updateAggregateProgress();
                        });
                        unsubscribers.push(() => { try { unsub(); } catch { } });
                    }
                }
                // Stop polling after a reasonable window (10 minutes)
                setTimeout(() => { unsubscribers.forEach(u => u()); }, 10 * 60 * 1000);
                this.bg.completeTask(uploadTaskId, `Upload queued on server • ${totalBatches} batch(es)`);
            } else {
                const groupsList = Object.keys(grouped);
                await this.exposureGroupservice.saveGroupedSampleInfo(grouped, currentOrg.Uid, currentOrg.Name);
                this.bg.updateTask(uploadTaskId, { done: groupsList.length, total, detail: `${groupsList.length}/${total} groups uploaded` });
                this.bg.completeTask(uploadTaskId, 'Upload complete');
            }
            if (total === 0) { this.snackBar.open('Nothing to recompute.', 'OK', { duration: 2000, verticalPosition: 'top' }); return; }
            if (shouldWaitForEf) {
                const efTaskId = this.bg.startTask({ label: 'Computing exceedance fractions', detail: `${total} exposure group(s)`, kind: 'compute', total });
                const res = await this.efTracker.waitForEf(currentOrg.Uid, ids, startIso, (done, totalCount) => {
                    try {
                        progress$.next({ done, total: totalCount });
                        this.bg.updateTask(efTaskId, { done, total: totalCount, detail: `${done}/${totalCount} updated` });
                        context.onProgress?.(done, totalCount);
                    } catch { }
                }, 60000);
                try { progressSnackRef?.dismiss(); } catch { }
                if (res.timedOut) {
                    this.bg.failTask(efTaskId, 'Timed out');
                    this.snackBar.open('EF recompute is taking longer than expected.', 'Dismiss', { duration: 5000 });
                } else {
                    this.bg.completeTask(efTaskId, 'Recompute complete');
                    this.snackBar.open('EF recompute complete.', 'OK', { duration: 3000 });
                }
            } else {
                // Large import: let EF compute in background and free the UI immediately
                const efTaskId = this.bg.startTask({ label: 'Computing exceedance fractions', detail: `${total} exposure group(s)`, kind: 'compute', total });
                // Don't block UI; just observe progress and complete task when done
                this.efTracker.waitForEf(currentOrg.Uid, ids, startIso, (done, totalCount) => {
                    this.bg.updateTask(efTaskId, { done, total: totalCount, detail: `${done}/${totalCount} updated` });
                }, 600000).then(res => {
                    if (res.timedOut) this.bg.failTask(efTaskId, 'Timed out'); else this.bg.completeTask(efTaskId, 'Recompute complete');
                }).catch(() => this.bg.failTask(efTaskId, 'Error'));
                this.snackBar.open(`Imported ${total} groups. EF vwill compute in the background.`, 'OK', { duration: 4000, verticalPosition: 'top' });
            }
        } catch (e: any) {
            try { progressSnackRef?.dismiss(); } catch { }
            const code = String(e?.code || '');
            const partial = code.includes('PARTIAL_UPLOAD_FAILED') || String(e?.message || '').includes('Some groups failed to upload');
            this.bg.failTask(uploadTaskId, partial ? 'Partial upload failed' : 'Upload failed');
            const msg = ((): string => {
                const text = String(e?.message || e || '');
                if (text.includes('AUTH_REQUIRED')) return 'Please sign in to save data.';
                if (text.includes('Missing or insufficient permissions') || text.includes('PERMISSION_DENIED')) return 'You do not have permission to save to this organization.';
                if (code === 'internal') return 'Server import failed. The upload was too large or timed out. We now split into smaller batches automatically; please try again.';
                if (partial) return text;
                return 'Save failed. Please try again.';
            })();
            this.snackBar.open(msg, 'Dismiss', { duration: 6000, verticalPosition: 'top' });
            return; // do not proceed to EF tracking on failure
        }
    }

    private slugify(text: string): string {
        return (text || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').replace(/-+/g, '-').slice(0, 120);
    }
}