import { Component, ElementRef, HostListener, ViewChild, inject, signal, DestroyRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { Firestore } from '@angular/fire/firestore';
import { collection, query, where, orderBy, doc, getDoc, writeBatch } from 'firebase/firestore';
import { collectionData } from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { OrganizationService } from '../../services/organization/organization.service';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { SelectionModel } from '@angular/cdk/collections';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSliderModule } from '@angular/material/slider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatMenuModule } from '@angular/material/menu';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { EzTableComponent } from '../../features/ez-table/ez-table.component';
import { SampleInfo } from '../../models/sample-info.model';
import { Observable, combineLatest, of, firstValueFrom } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { buildHistoryEfItems, buildLatestEfItems } from '../../utils/ef-items.util';
import { EzColumn } from '../../models/ez-column.model';
import { BackgroundStatusService } from '../../services/background-status/background-status.service';
import * as XLSX from 'xlsx';
import { ActivatedRoute, Router } from '@angular/router';

@Component({
  selector: 'app-exceedance-fraction',
  imports: [CommonModule, FormsModule, MatTableModule, MatIconModule, MatButtonModule, MatSlideToggleModule, MatTooltipModule, MatSliderModule, MatProgressSpinnerModule, MatCheckboxModule, MatMenuModule, MatButtonToggleModule, MatFormFieldModule, MatInputModule, EzTableComponent],
  templateUrl: './exceedance-fraction.component.html',
  styleUrl: './exceedance-fraction.component.scss'
})
export class ExceedanceFractionComponent {
  private firestore = inject(Firestore);
  private fns = inject(Functions);
  private orgService = inject(OrganizationService);
  private bg = inject(BackgroundStatusService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  exposureGroups$!: Observable<any[]>;
  resultsData: SampleInfo[] = [];
  // Streams
  efItems$!: Observable<any[]>;        // full history
  latestEfItems$!: Observable<any[]>;  // one per group
  filteredEfItems$!: Observable<any[]>;
  filteredLatestEfItems$!: Observable<any[]>;
  // Toggle (default ON)
  showLatest = signal(true);
  // Selection model (always enabled on this page)
  selection = new SelectionModel<any>(true, []);
  // Undo Import UI
  showUndo = signal(false);
  selectedJobId = signal<string | null>(null);
  undoBusy = signal(false);
  // Deletion busy state
  deleting = signal(false);
  jobs$!: Observable<any[]>;
  // Quick filter by Exposure Group (used by table's built-in filtering)
  filter = signal('');
  // Separate Agent filter (applied to the dataset before handing to the table)
  agentFilter = signal('');
  // Legend bucket filter: '', 'good' (<5%), 'warn' (5-20%), 'bad' (>=20%), 'custom' (>= customThreshold)
  bucket = signal<'' | 'good' | 'warn' | 'bad' | 'custom'>('');
  // Custom threshold (fraction). Default 0.25 (25%). Editable via legend chip.
  customThreshold = signal(0.25);
  editingCustom = signal(false);
  @ViewChild('customThresholdWrapper') customWrapperRef?: ElementRef<HTMLElement>;
  // Observable that computes the most recent sample date across all items
  mostRecentSampleDate$!: Observable<Date | null>;
  private bucketFor(val: number | null | undefined): 'good' | 'warn' | 'bad' {
    const v = typeof val === 'number' ? val : 0;
    if (v < 0.05) return 'good';
    if (v < 0.20) return 'warn';
    return 'bad';
  }
  // Table configuration for ez-table (generic)
  readonly efSummaryColumns = [
    new EzColumn({ Name: 'ExposureGroup', DisplayName: 'Exposure Group' }),
    new EzColumn({ Name: 'ExceedanceFraction', DisplayName: 'Exceedance Fraction', Format: 'percent-badge' }),
    new EzColumn({ Name: 'Trend', DisplayName: 'Trend', Format: 'trend' }),
    new EzColumn({ Name: 'Agent', DisplayName: 'Agent' }),
    new EzColumn({ Name: 'OELNumber', DisplayName: 'OEL' }),
    new EzColumn({ Name: 'DateCalculated', DisplayName: 'Calculation Date', Format: 'date' }),
    new EzColumn({ Name: 'SamplesUsed', DisplayName: 'Samples Used' })
  ];
  readonly efDetailColumns: string[] = ['SampleDate', 'ExposureGroup', 'TWA', 'Notes', 'SampleNumber'];
  readonly efDetailForItem = (item: any) => item?.ResultsUsed ?? [];
  // When selecting, prepend a checkbox column
  readonly efSummaryColumnsWithSelect = [
    new EzColumn({ Name: 'Select', DisplayName: '', Sortable: false }),
    ...this.efSummaryColumns
  ];

  constructor() {
    const orgId = this.orgService.orgStore.currentOrg()?.Uid;
    const ref = orgId
      ? collection(this.firestore, `organizations/${orgId}/exposureGroups`)
      : collection(this.firestore, 'organizations/unknown/exposureGroups');
    this.exposureGroups$ = collectionData(ref as any, { idField: 'Uid' }).pipe(map(d => d as any[]));

    // Use pure utility functions (with internal memoization) to build items
    this.efItems$ = this.exposureGroups$.pipe(map(groups => buildHistoryEfItems(groups as any)));
    this.latestEfItems$ = this.exposureGroups$.pipe(map(groups => buildLatestEfItems(groups as any)));
    // Wire filtered streams to react to both data and bucket changes
    const bucket$ = toObservable(this.bucket);
    const agent$ = toObservable(this.agentFilter);
    this.filteredEfItems$ = combineLatest([this.efItems$, bucket$, toObservable(this.customThreshold), agent$]).pipe(
      map(([items, b, custom, agent]) => {
        let out = items;
        if (b) {
          out = (b === 'custom') ? out.filter(i => (i?.ExceedanceFraction ?? 0) >= custom)
            : out.filter(i => i?.EfBucket === b);
        }
        if (agent && agent.trim()) {
          const a = agent.trim().toLowerCase();
          out = out.filter(i => String(i?.Agent ?? '').toLowerCase().includes(a));
        }
        return out;
      })
    );
    this.filteredLatestEfItems$ = combineLatest([this.latestEfItems$, bucket$, toObservable(this.customThreshold), agent$]).pipe(
      map(([items, b, custom, agent]) => {
        let out = items;
        if (b) {
          out = (b === 'custom') ? out.filter(i => (i?.ExceedanceFraction ?? 0) >= custom)
            : out.filter(i => i?.EfBucket === b);
        }
        if (agent && agent.trim()) {
          const a = agent.trim().toLowerCase();
          out = out.filter(i => String(i?.Agent ?? '').toLowerCase().includes(a));
        }
        return out;
      })
    );

    // Compute most recent sample date across all items (reactive to showLatest toggle)
    this.mostRecentSampleDate$ = combineLatest([
      toObservable(this.showLatest),
      this.filteredLatestEfItems$,
      this.filteredEfItems$
    ]).pipe(
      map(([latest, latestItems, historyItems]) => {
        const items = latest ? latestItems : historyItems;
        if (!items || items.length === 0) return null;
        let maxDate = 0;
        for (const item of items) {
          const results = item?.ResultsUsed || [];
          for (const r of results) {
            const t = r?.SampleDate ? new Date(r.SampleDate).getTime() : 0;
            if (!isNaN(t) && t > maxDate) maxDate = t;
          }
        }
        return maxDate > 0 ? new Date(maxDate) : null;
      })
    );

    // React to query param changes: if agent=Name is present, apply agent filter; otherwise, clear it
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const agent = (params.get('agent') || '').trim();
        if (!agent || agent.toLowerCase() === 'all') {
          this.agentFilter.set('');
        } else {
          this.agentFilter.set(agent);
        }
      });

    // Recent import jobs (for undo), ordered by completedAt desc, reactive to org changes
    this.jobs$ = toObservable(this.orgService.currentOrg).pipe(
      map(org => org?.Uid || null),
      switchMap(orgUid => {
        if (!orgUid) return of([]);
        const jobsRef = collection(this.firestore as any, `organizations/${orgUid}/importJobs`);
        const qy = query(jobsRef as any, orderBy('completedAt', 'desc'));
        return collectionData(qy as any, { idField: 'id' });
      }),
      map((rows: any[]) => rows.map(j => ({
        id: j.id,
        status: j.status ?? null,
        phase: j.phase ?? null,
        startedAt: j.startedAt?.toDate ? j.startedAt.toDate() : (j.startedAt ? new Date(j.startedAt) : null),
        completedAt: j.completedAt?.toDate ? j.completedAt.toDate() : (j.completedAt ? new Date(j.completedAt) : null),
        undoneAt: j.undoneAt?.toDate ? j.undoneAt.toDate() : (j.undoneAt ? new Date(j.undoneAt) : null),
        undoAvailable: !!j.undoAvailable,
        totalRows: j.totalRows ?? null,
        rowsWritten: j.rowsWritten ?? null,
        groupsProcessed: j.groupsProcessed ?? null,
      })))
    );
  }

  // Selection is always enabled; no toggle handler needed

  // Selection helpers (see methods near the end of the class)

  async undoSelectedJob() {
    const orgId = this.orgService.orgStore.currentOrg()?.Uid;
    const jobId = this.selectedJobId();
    if (!orgId || !jobId) return;
    try {
      this.undoBusy.set(true);
      // Start a background task and subscribe to progress on the job doc
      const taskId = this.bg.startTask({ label: 'Undo import', detail: 'Preparing…', kind: 'compute', indeterminate: true });
      const jobDoc = doc(this.firestore as any, `organizations/${orgId}/importJobs/${jobId}`);
      const { onSnapshot } = await import('firebase/firestore');
      const unsub = onSnapshot(jobDoc as any, (snap: any) => {
        const d = (snap?.data?.() || {}) as any;
        const processed = d.undoGroupsProcessed || 0;
        const total = d.undoGroupsTotal || 0;
        const status = d.undoStatus || 'running';
        const removed = d.undoRowsRemoved || 0;
        const restored = d.undoRowsRestored || 0;
        // Update background task progress
        const detail = total
          ? `Undoing ${processed}/${total} group(s) • removed ${removed}, restored ${restored}`
          : `Undoing… removed ${removed}, restored ${restored}`;
        this.bg.updateTask(taskId, { done: total ? processed : undefined, total: total || undefined, detail });
        if (status === 'completed' || status === 'completed-with-errors') {
          try { unsub(); } catch { }
          const doneMsg = status === 'completed-with-errors' ? 'Undo complete (with some errors).' : 'Undo complete.';
          this.bg.completeTask(taskId, doneMsg);
          this.selectedJobId.set(null);
          this.showUndo.set(false);
        }
      }, () => { /* ignore */ });

      const callable = httpsCallable<{ orgId: string; jobId: string }, any>(this.fns, 'undoImport');
      // Fire-and-follow: kick off the undo and follow progress from the job doc.
      // The callable may time out on the client before the work finishes; that's okay.
      callable({ orgId, jobId }).then(() => {
        // no-op; completion is handled by the snapshot listener which completes the task
      }).catch((err: any) => {
        const code = String(err?.code || '');
        if (code === 'functions/deadline-exceeded') {
          // Keep following background progress; the function continues server-side.
          this.bg.updateTask(taskId, { detail: 'Undo is running in the background…', indeterminate: false });
          return; // do not surface as an error
        }
        // Real error: fail the task
        try { this.bg.failTask(taskId, err?.message || 'Undo failed'); } catch { }
      });
    } catch (e) {
      console.error('Undo failed', e);
    } finally {
      this.undoBusy.set(false);
    }
  }

  beginEditCustom(event: Event) {
    event.stopPropagation();
    if (this.editingCustom()) {
      // Toggle off
      this.editingCustom.set(false);
      return;
    }
    this.editingCustom.set(true);
    this.bucket.set('custom');
  }

  toggleEditCustom(event: Event) { this.beginEditCustom(event); }

  private parseAndSetCustom(v: number) {
    if (!isNaN(v)) {
      if (v > 1) v = v / 100; // treat whole number as percent
      v = Math.min(Math.max(v, 0), 1);
      this.customThreshold.set(v);
      // Keep custom bucket selected
      if (this.bucket() !== 'custom') this.bucket.set('custom');
    }
  }

  commitCustomThreshold(raw: any) {
    let v = parseFloat(String(raw).trim());
    this.parseAndSetCustom(v);
    this.editingCustom.set(false);
  }

  updateCustomFromSlider(val: number) {
    this.parseAndSetCustom(val / 100);
  }

  updateCustomFromInput(raw: any) {
    let v = parseFloat(String(raw).trim());
    this.parseAndSetCustom(v);
  }

  toggleCustomBucket() {
    this.bucket.set(this.bucket() === 'custom' ? '' : 'custom');
  }

  // Close editor when clicking outside
  @HostListener('document:click', ['$event']) onDocumentClick(ev: MouseEvent) {
    if (!this.editingCustom()) return;
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    // If click is inside the wrapper, ignore
    if (this.customWrapperRef?.nativeElement.contains(target)) return;
    this.editingCustom.set(false);
  }

  // Close on Escape
  @HostListener('document:keydown.escape') onEscape() {
    if (this.editingCustom()) this.editingCustom.set(false);
  }

  async exportEfExcel() {
    try {
      const items = await firstValueFrom(this.showLatest() ? this.filteredLatestEfItems$ : this.filteredEfItems$);
      const rows = (items || []).map((it: any) => {
        const results = Array.isArray(it?.ResultsUsed) ? it.ResultsUsed : [];
        const mostRecentDateMs = results.reduce((max: number, r: any) => {
          const t = r?.SampleDate ? new Date(r.SampleDate).getTime() : NaN;
          return isNaN(t) ? max : Math.max(max, t);
        }, 0);
        // Normalize to noon to avoid TZ midnight shifts appearing as prior/next day in spreadsheet apps
        const mostRecentDate = mostRecentDateMs ? (() => { const d = new Date(mostRecentDateMs); d.setHours(12, 0, 0, 0); return d; })() : undefined;
        const efFraction = typeof it?.ExceedanceFraction === 'number' ? it.ExceedanceFraction : 0; // 0..1
        const efPercent = Math.round(efFraction * 10000) / 100; // percent value with 2 decimals precision
        return {
          ExposureGroup: String(it?.ExposureGroup ?? ''),
          ExceedanceFraction: efPercent, // numeric percent (no % sign; formatted to 2 decimals)
          MostRecentSampleDate: mostRecentDate // Date object for typed date cell (undefined if missing)
        };
      })
        // Default sort by Exposure Group (ascending)
        .sort((a: any, b: any) => String(a.ExposureGroup).localeCompare(String(b.ExposureGroup), undefined, { sensitivity: 'base' }));

      // Build an array-of-arrays for the sheet
      const header = ['Exposure Group', 'Exceedance Fraction', 'Most Recent Sample Date'];
      const data: any[][] = [
        header,
        ...rows.map(r => [r.ExposureGroup, r.ExceedanceFraction, r.MostRecentSampleDate])
      ];
      const ws = XLSX.utils.aoa_to_sheet(data, { cellDates: true });

      // Column widths
      (ws as any)['!cols'] = [{ wch: 36 }, { wch: 24 }, { wch: 24 }];

      // Apply number formats and attempt to center date cells
      const range = XLSX.utils.decode_range(ws['!ref'] as string);
      for (let R = range.s.r + 1; R <= range.e.r; R++) { // skip header row
        // Exceedance Fraction (numeric, 2 decimals) in column 1 (0-based index)
        const efAddr = XLSX.utils.encode_cell({ r: R, c: 1 });
        const efCell = ws[efAddr];
        if (efCell) {
          efCell.t = 'n';
          // Show exactly two decimal places (no percent sign)
          (efCell as any).z = '0.00';
        }

        // Most Recent Sample Date in column 2
        const dateAddr = XLSX.utils.encode_cell({ r: R, c: 2 });
        const dCell = ws[dateAddr];
        const v = dCell?.v;
        if (v instanceof Date) {
          // Mark as date and apply a friendly format
          dCell.t = 'd';
          (dCell as any).z = 'mmm d, yyyy';
          // Best-effort: try to center the date column. Note: styles are not written in the community edition of SheetJS.
          (dCell as any).s = { alignment: { horizontal: 'center' } };
        } else if (typeof v === 'number') {
          // If a numeric Excel date leaks through, still set a format
          dCell.t = 'n';
          (dCell as any).z = 'mmm d, yyyy';
          (dCell as any).s = { alignment: { horizontal: 'center' } };
        }
      }

      // Enable auto-filter so spreadsheet apps recognize the header row
      const lastRow = Math.max(range.e.r + 1, 1);
      (ws as any)['!autofilter'] = { ref: `A1:C${lastRow}` };
      // Freeze header row (supported in many apps, including Excel; Numbers may ignore)
      (ws as any)['!freeze'] = { xSplit: 0, ySplit: 1 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, this.showLatest() ? 'EF Latest' : 'EF History');
      const nowXlsx = new Date();
      const tsXlsx = `${String(nowXlsx.getMonth() + 1).padStart(2, '0')}-${String(nowXlsx.getDate()).padStart(2, '0')}-${nowXlsx.getFullYear()}`;
      XLSX.writeFile(wb, `updated-ef_${this.showLatest() ? 'latest' : 'history'}_${tsXlsx}.xlsx`);
    } catch (e) {
      console.error('Excel export failed', e);
    }
  }

  // Selection helpers use the currently displayed list passed from template
  isAllSelected(items: any[]): boolean {
    const total = items?.length || 0;
    const selected = this.selection.selected.length;
    return total > 0 && selected === total;
  }

  toggleAllRows(items: any[]) {
    if (!Array.isArray(items) || items.length === 0) {
      this.selection.clear();
      return;
    }
    if (this.isAllSelected(items)) {
      this.selection.clear();
    } else {
      this.selection.clear();
      this.selection.select(...items);
    }
  }

  checkboxLabel(row?: any): string {
    if (!row) {
      return `${this.selection.hasValue() ? 'deselect' : 'select'} all`;
    }
    const key = row?.ExposureGroup || row?.Uid || '';
    return `${this.selection.isSelected(row) ? 'deselect' : 'select'} ${key}`;
  }

  async deleteSelectedGroups() {
    const orgId = this.orgService.orgStore.currentOrg()?.Uid;
    if (!orgId) return;
    const selectedRows = this.selection.selected || [];
    if (!selectedRows.length) return;
    const docIds = new Set<string>();
    for (const row of selectedRows) {
      const docId = row?.DocUid || row?.Uid;
      if (docId) docIds.add(String(docId));
    }
    if (!docIds.size) return;
    const ok = window.confirm(`Delete ${docIds.size} exposure group(s)? This cannot be undone.`);
    if (!ok) return;
    let taskId: string | null = null;
    try {
      this.deleting.set(true);
      taskId = this.bg.startTask({ label: 'Deleting exposure groups', detail: `${docIds.size} group(s)`, kind: 'other', indeterminate: true });
      const batch = writeBatch(this.firestore as any);
      for (const docId of docIds) {
        const ref = doc(this.firestore as any, `organizations/${orgId}/exposureGroups/${docId}`);
        batch.delete(ref);
      }
      await batch.commit();
      this.selection.clear();
      try { if (taskId) this.bg.completeTask(taskId, `Deleted ${docIds.size} group(s)`); } catch { }
    } catch (e) {
      console.error('Bulk delete failed', e);
      try { if (taskId) this.bg.failTask(taskId, 'Delete failed'); } catch { }
      alert('Bulk delete failed; see console for details.');
    }
    finally {
      this.deleting.set(false);
    }
  }

  // Clear exposure group filter
  clearFilter() { this.filter.set(''); }

  // Clear agent filter and remove it from the URL
  clearAgentFilter() {
    this.agentFilter.set('');
    try {
      this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { agent: null },
        queryParamsHandling: 'merge'
      });
    } catch { /* ignore navigation errors */ }
  }

}
