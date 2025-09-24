import { Injectable, inject } from '@angular/core';
import { ExceedanceFractionService } from '../../services/exceedance-fraction/exceedance-fraction.service';
import { ExposureGroupService } from '../../services/exposure-group/exposure-group.service';
import { EfRecomputeTrackerService } from '../../services/exceedance-fraction/ef-recompute-tracker.service';
import { OrganizationService } from '../../services/organization/organization.service';
import { Firestore } from '@angular/fire/firestore';
import { Auth } from '@angular/fire/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { SnackService } from '../../services/ui/snack.service';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
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
    private snackBar = inject(SnackService);
    private agentService = inject(AgentService);

    calculateExceedanceFraction(rows: SampleInfo[]): number {
        const TWAlist: number[] = this.exposureGroupservice.getTWAListFromSampleInfo(rows);
        return this.exceedanceFractionservice.calculateExceedanceProbability(TWAlist, 0.05);
    }

    async save(context: SaveContext) {
        const currentOrg = this.organizationservice.currentOrg;
        if (!currentOrg) throw new Error('No current organization');
        const uid = this.auth.currentUser?.uid;
        if (!uid) { this.snackBar.open('Please sign in to save data.', 'Dismiss', { duration: 4000, verticalPosition: 'top' }); return; }
        try {
            const orgRef = doc(this.firestore as any, `organizations/${currentOrg.Uid}`);
            const snap = await getDoc(orgRef as any);
            if (!snap.exists()) await setDoc(orgRef as any, { Uid: currentOrg.Uid, Name: currentOrg.Name, UserUids: uid ? [uid] : [] });
            else {
                const data: any = snap.data();
                const members: string[] = Array.isArray(data?.UserUids) ? data.UserUids : [];
                if (uid && !members.includes(uid)) { this.snackBar.open('You are not a member of the selected organization in this environment.', 'Dismiss', { duration: 6000, verticalPosition: 'top' }); return; }
            }
        } catch { }
        const validRows = context.validRows;
        const allAgents = Array.from(new Set(validRows.map(r => (r.Agent || '').trim()).filter(a => !!a)));
        if (allAgents.length) {
            const orgId = currentOrg.Uid;
            let existing: Record<string, number> = {};
            try { const list$ = this.agentService.list(orgId); const list = await firstValueFrom(list$); existing = Object.fromEntries((list || []).map(a => [a.Name, a.OELNumber])); } catch { }
            const missing = allAgents.filter(a => existing[a] === undefined);
            if (missing.length) {
                // Defer optional agent dialog to component layer if needed later
            }
        }
        const grouped = this.exposureGroupservice.separateSampleInfoByExposureGroup(validRows);
        const startIso = new Date().toISOString();
        const ids = Object.keys(grouped).map(name => this.slugify(name));
        const total = ids.length;
        let progressSnackRef: any = null;
        const progress$ = new BehaviorSubject<{ done: number; total: number }>({ done: 0, total });
        if (total > 0) {
            try {
                const { ProgressSnackComponent } = await import('../../shared/progress-snack/progress-snack.component');
                progressSnackRef = this.snackBar.openFromComponent(ProgressSnackComponent, { data: { label: 'Recomputing EF…', progress$ } });
            } catch { }
        }
        try {
            await this.exposureGroupservice.saveGroupedSampleInfo(grouped, currentOrg.Uid, currentOrg.Name);
            if (total === 0) { this.snackBar.open('Nothing to recompute.', 'OK', { duration: 2000, verticalPosition: 'top' }); return; }
            const res = await this.efTracker.waitForEf(currentOrg.Uid, ids, startIso, (done, totalCount) => {
                try { progress$.next({ done, total: totalCount }); context.onProgress?.(done, totalCount); } catch { }
            }, 60000);
            try { progressSnackRef?.dismiss(); } catch { }
            if (res.timedOut) this.snackBar.open('EF recompute is taking longer than expected.', 'Dismiss', { duration: 5000 });
            else this.snackBar.open('EF recompute complete.', 'OK', { duration: 3000 });
        } catch {
            try { progressSnackRef?.dismiss(); } catch { }
            this.snackBar.open('Save failed. Please try again.', 'Dismiss', { duration: 5000 });
        }
    }

    private slugify(text: string): string {
        return (text || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').replace(/-+/g, '-').slice(0, 120);
    }
}