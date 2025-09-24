import { CommonModule } from '@angular/common';
import { Component, inject, computed, signal } from '@angular/core';
import * as XLSX from 'xlsx';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { SampleInfo } from '../../models/sample-info.model';
import { MatTableModule } from '@angular/material/table';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatChipsModule } from '@angular/material/chips';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ExceedanceFractionService } from '../../services/exceedance-fraction/exceedance-fraction.service';
import { ExposureGroupService } from '../../services/exposure-group/exposure-group.service';
import { OrganizationService } from '../../services/organization/organization.service';
import { read } from 'xlsx';
import { Firestore } from '@angular/fire/firestore';
import { Auth } from '@angular/fire/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { EfRecomputeTrackerService } from '../../services/exceedance-fraction/ef-recompute-tracker.service';
import { SnackService } from '../../services/ui/snack.service';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { AgentsDialogComponent } from './agents-dialog/agents-dialog.component';
import { AgentService } from '../../services/agent/agent.service';
import { ColumnMappingDialogComponent } from './column-mapping-dialog/column-mapping-dialog.component';
@Component({
  selector: 'app-data',
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatTableModule,
    MatSnackBarModule,
    MatChipsModule,
    MatTooltipModule,
    MatDialogModule,

  ],
  templateUrl: './data.component.html',
  styleUrl: './data.component.scss'
})
export class DataComponent {
  exceedanceFractionservice = inject(ExceedanceFractionService)
  exposureGroupservice = inject(ExposureGroupService)
  organizationservice = inject(OrganizationService)
  efTracker = inject(EfRecomputeTrackerService)
  private snackBar: SnackService = inject(SnackService)
  private firestore = inject(Firestore)
  private auth = inject(Auth)
  private dialog = inject(MatDialog)
  private agentService = inject(AgentService)
  fileName = signal<string>('');
  // Stored last mapping state for manual reopen
  private lastWorkbook: XLSX.WorkBook | null = null;
  private lastSheetOptions: { sheet: string; headers: string[]; mapping: Record<string, string | null>; recognized: number; requiredMatches: number; parsed: any[] }[] = [];
  private lastRequired: string[] = [];
  private lastOptional: string[] = [];
  private lastSelectedSheet: string | null = null;
  private lastFinalMapping: Record<string, string | null> | null = null;
  // Parsed + validated rows (SampleInfo with validation metadata)
  excelData = signal<(SampleInfo & { __invalid?: boolean; __errors?: string[] })[]>([]);
  exceedanceFraction!: number;
  columnsToDisplay = ['SampleNumber', 'SampleDate', 'ExposureGroup', 'TWA'];
  columnsToDisplayWithExpand = [...this.columnsToDisplay, 'Errors'];
  expandedElement!: SampleInfo | null;
  invalidCount = computed(() => this.excelData().filter(r => r.__invalid).length);
  hasInvalidRows = computed(() => this.invalidCount() > 0);
  totalCount = computed(() => this.excelData().length);
  validCount = computed(() => this.excelData().filter(r => !r.__invalid).length);
  invalidCellCount = computed(() => this.excelData().reduce((acc, r) => acc + ((r.__errors || []).length), 0));
  errorCounts = computed(() => {
    const counts: Record<string, number> = { ExposureGroup: 0, TWA: 0, SampleDate: 0 };
    for (const r of this.excelData()) {
      for (const e of (r.__errors || [])) {
        if (e.includes('ExposureGroup')) counts['ExposureGroup']++;
        else if (e.includes('TWA')) counts['TWA']++;
        else if (e.includes('SampleDate')) counts['SampleDate']++;
      }
    }
    return counts;
  });
  errorTooltip = computed(() => {
    const c = this.errorCounts();
    return `ExposureGroup: ${c['ExposureGroup']}, TWA: ${c['TWA']}, SampleDate: ${c['SampleDate']}`;
  });
  headerLabels: Record<string, string> = {
    SampleNumber: 'Sample #',
    SampleDate: 'Sample Date',
    ExposureGroup: 'Exposure Group',
    TWA: 'TWA'
  };
  isExpanded(element: SampleInfo) {
    return this.expandedElement === element;
  }
  toggle(element: SampleInfo) {
    this.expandedElement = this.isExpanded(element) ? null : element;
  }
  onFileChange(event: any) {
    const file = event.target.files[0];
    if (file?.name) this.fileName.set(file.name);
    const fileReader = new FileReader();
    fileReader.onload = (e: any) => {
      const workbook = read(e.target.result, { type: 'binary', cellDates: true });
      this.lastWorkbook = workbook;
      const required = ['SampleDate', 'ExposureGroup', 'TWA'];
      const optional = ['SampleNumber', 'Agent', 'Notes'];
      const sheetOptions = workbook.SheetNames.map(name => {
        const headers = this.getSheetHeaders(workbook, name);
        const mapping = this.computeAutoMapping(headers);
        const recognized = Object.values(mapping).filter(v => !!v).length;
        const requiredMatches = required.filter(r => !!mapping[r]).length;
        const parsed = this.parseRows(workbook, name, mapping);
        return { sheet: name, headers, mapping, recognized, requiredMatches, parsed };
      });
      // Choose default sheet: maximize requiredMatches then recognized then name
      sheetOptions.sort((a, b) => {
        if (b.requiredMatches !== a.requiredMatches) return b.requiredMatches - a.requiredMatches;
        if (b.recognized !== a.recognized) return b.recognized - a.recognized;
        return a.sheet.localeCompare(b.sheet);
      });
      const primary = sheetOptions[0];
      if (!primary || primary.parsed.length === 0) {
        this.excelData.set([]);
        this.snackBar.open('No sheets contained recognizable data. Please check your file.', 'Dismiss', { duration: 6000, verticalPosition: 'top' });
        return;
      }
      // Persist state for potential reopen
      this.lastSheetOptions = sheetOptions;
      this.lastRequired = required;
      this.lastOptional = optional;
      this.lastSelectedSheet = primary.sheet;
      this.lastFinalMapping = primary.mapping;

      const allRequiredMapped = required.every(r => !!primary.mapping[r]);
      if (allRequiredMapped) {
        // Skip dialog, use primary mapping immediately
        this.excelData.set(primary.parsed);
        this.calculateExceedanceFraction();
        return;
      }
      const dlgRef = this.dialog.open(ColumnMappingDialogComponent, {
        data: {
          sheetOptions: sheetOptions.map(s => ({ name: s.sheet, headers: s.headers, mapping: s.mapping, requiredMatches: s.requiredMatches, recognized: s.recognized })),
          selected: primary.sheet,
          required,
          optional
        }, width: '60vw', maxWidth: '60vw', maxHeight: '75vh', panelClass: 'mapping-dialog-panel'
      });
      dlgRef.afterClosed().subscribe(result => {
        if (!result) {
          this.snackBar.open('Import canceled.', 'Dismiss', { duration: 3000, verticalPosition: 'top' });
          return;
        }
        const chosenName = result.sheet || primary.sheet;
        const chosen = sheetOptions.find(s => s.sheet === chosenName) || primary;
        const finalMapping = result.mapping || chosen.mapping;
        const reparsed = this.parseRows(workbook, chosen.sheet, finalMapping);
        const stillMissing = required.filter(r => !finalMapping[r]);
        if (stillMissing.length) {
          this.snackBar.open('Missing required columns: ' + stillMissing.join(', '), 'Dismiss', { duration: 6000, verticalPosition: 'top' });
          return;
        }
        this.excelData.set(reparsed);
        // Update last state
        this.lastSelectedSheet = chosen.sheet;
        this.lastFinalMapping = finalMapping;
        this.calculateExceedanceFraction();
      });
    };
    fileReader.readAsArrayBuffer(file);

  }
  openMappingDialog() {
    if (!this.lastWorkbook || !this.lastSheetOptions.length) return;
    const workbook = this.lastWorkbook;
    const required = this.lastRequired;
    const optional = this.lastOptional;
    const sheetOptions = this.lastSheetOptions;
    const primary = sheetOptions.find(s => s.sheet === (this.lastSelectedSheet || sheetOptions[0].sheet)) || sheetOptions[0];
    const dlgRef = this.dialog.open(ColumnMappingDialogComponent, {
      data: {
        sheetOptions: sheetOptions.map(s => ({ name: s.sheet, headers: s.headers, mapping: s.mapping, requiredMatches: s.requiredMatches, recognized: s.recognized })),
        selected: primary.sheet,
        required,
        optional
      }, width: '60vw', height: '75vh', maxWidth: '60vw', maxHeight: '75vh', panelClass: 'mapping-dialog-panel'
    });
    dlgRef.afterClosed().subscribe(result => {
      if (!result) return;
      const chosenName = result.sheet || primary.sheet;
      const chosen = sheetOptions.find(s => s.sheet === chosenName) || primary;
      const finalMapping = result.mapping || chosen.mapping;
      const reparsed = this.parseRows(workbook, chosen.sheet, finalMapping);
      const stillMissing = required.filter(r => !finalMapping[r]);
      if (stillMissing.length) {
        this.snackBar.open('Missing required columns: ' + stillMissing.join(', '), 'Dismiss', { duration: 6000, verticalPosition: 'top' });
        return;
      }
      this.excelData.set(reparsed);
      this.lastSelectedSheet = chosen.sheet;
      this.lastFinalMapping = finalMapping;
      this.calculateExceedanceFraction();
    });
  }
  // Column mapping helpers
  private getSheetHeaders(workbook: XLSX.WorkBook, sheetName: string): string[] {
    const rows: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
    if (!rows.length) return [];
    return rows[0].map(h => (h == null ? '' : String(h).trim()));
  }
  private normalizeHeader(h: string): string {
    return h.toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  private computeAutoMapping(headers: string[]): Record<string, string | null> {
    if (!Array.isArray(headers)) headers = [];
    const mapping: Record<string, string | null> = { SampleDate: null, ExposureGroup: null, TWA: null, SampleNumber: null, Agent: null, Notes: null };
    const synonyms: Record<string, string[]> = {
      SampleDate: ['sampledate', 'date', 'sampledt', 'samplingdate'],
      ExposureGroup: ['exposuregroup', 'group', 'groupname', 'expgroup'],
      TWA: ['twa', 'result', 'value', 'measurement'],
      SampleNumber: ['samplenumber', 'sampleno', 'sample#', 'samplenum', 'sampleid', 'sample'],
      Agent: ['agent', 'chemical', 'substance', 'analyte'],
      Notes: ['notes', 'note', 'comment', 'comments', 'remarks', 'remark']
    };
    const normalizedHeaders = headers
      .filter(h => h !== undefined && h !== null)
      .map(h => {
        try { return { raw: h, norm: this.normalizeHeader(String(h)) }; } catch { return { raw: String(h ?? ''), norm: '' }; }
      })
      .filter(h => h && typeof h.norm === 'string');

    // Build reverse lookup from normalized header to original raw header
    const lookup: Record<string, string> = {};
    for (const entry of normalizedHeaders) {
      if (!entry.norm) continue;
      if (lookup[entry.norm] === undefined) lookup[entry.norm] = entry.raw; // keep first occurrence
    }
    for (const field of Object.keys(mapping)) {
      const syns = synonyms[field] || [];
      for (const syn of syns) {
        if (lookup[syn] && !mapping[field]) {
          mapping[field] = lookup[syn];
          break;
        }
      }
    }
    // Fuzzy fallbacks for common variations if still unmapped
    if (!mapping['TWA']) {
      const fuzzy = headers.find(h => /twa|result|value/i.test(h || ''));
      if (fuzzy) mapping['TWA'] = fuzzy;
    }
    if (!mapping['SampleDate']) {
      const fuzzyDate = headers.find(h => /sample\s*date|date/i.test(h || ''));
      if (fuzzyDate) mapping['SampleDate'] = fuzzyDate;
    }
    return mapping;
  }
  private parseRows(workbook: XLSX.WorkBook, sheetName: string, mapping: Record<string, string | null>) {
    const rawRows: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    return rawRows.map(row => this.mapAndValidateRow(row, mapping));
  }
  private mapAndValidateRow(row: any, mapping: Record<string, string | null>): (SampleInfo & { __invalid?: boolean; __errors?: string[] }) {
    const errors: string[] = [];
    const normalized: SampleInfo = new SampleInfo();
    const getVal = (field: string) => {
      const header = mapping[field];
      if (!header) return undefined;
      return row[header];
    };
    const sampleNumber = this.tryParseNumber(getVal('SampleNumber'));
    normalized.SampleNumber = Number.isFinite(sampleNumber) ? (sampleNumber as number) : undefined;
    const exposureGroup = this.normalizeString(getVal('ExposureGroup'));
    if (!exposureGroup) errors.push('ExposureGroup is required');
    normalized.ExposureGroup = exposureGroup;
    const twaRaw = getVal('TWA');
    const twa = this.tryParseNumber(twaRaw);
    if (twaRaw === undefined || twaRaw === '') {
      errors.push('TWA is required');
    } else if (!Number.isFinite(twa)) {
      errors.push('TWA must be a number');
    } else if ((twa as number) <= 0) {
      errors.push('TWA must be > 0');
    }
    normalized.TWA = Number.isFinite(twa) ? (twa as number) : undefined;
    const sampleDateRaw = getVal('SampleDate');
    const parsedDate = this.parseDate(sampleDateRaw);
    if (!parsedDate) errors.push('SampleDate is required/invalid');
    normalized.SampleDate = parsedDate ? parsedDate.toISOString() : '';
    normalized.Agent = this.normalizeString(getVal('Agent'));
    normalized.Notes = this.normalizeString(getVal('Notes'));
    return { ...(normalized as any), __invalid: errors.length > 0, __errors: errors };
  }

  calculateExceedanceFraction() {
    //create a variable to separate the ExposureGroup column into an array
    const exposureGroups: {
      [key: string]: SampleInfo[];
    } = this.exposureGroupservice.separateSampleInfoByExposureGroup(this.excelData() as SampleInfo[]);
    //calculate the exceedance fraction for each ExposureGroup
    for (const exposureGroupName in exposureGroups) {
      const exposureGroup = exposureGroups[exposureGroupName];
      if (exposureGroup.length === 1) {
        continue;
      }
      const TWAlist: number[] = this.exposureGroupservice.getTWAListFromSampleInfo(exposureGroup);
      const exceedanceFraction = this.exceedanceFractionservice.calculateExceedanceProbability(TWAlist, 0.05);
      console.log(exposureGroupName, "||", exceedanceFraction, "||| length: ", exposureGroup.length);
    }


    const TWAlist: number[] = this.exposureGroupservice.getTWAListFromSampleInfo(this.excelData() as SampleInfo[]);
    this.exceedanceFraction = this.exceedanceFractionservice.calculateExceedanceProbability(TWAlist, 0.05);
  }

  async saveSampleInfo() {
    const currentOrg = this.organizationservice.currentOrg;
    if (!currentOrg) { throw new Error("No current organization") }
    const uid = this.auth.currentUser?.uid;
    if (!uid) {
      this.snackBar.open('Please sign in to save data.', 'Dismiss', { duration: 4000, verticalPosition: "top" });
      return;
    }
    // Ensure org exists in this environment and user is a member (helps when using emulators)
    try {
      const orgRef = doc(this.firestore as any, `organizations/${currentOrg.Uid}`);
      const snap = await getDoc(orgRef as any);
      if (!snap.exists()) {
        // Seed minimal org document so membership rule passes (only safe in emulator or new env)
        await setDoc(orgRef as any, { Uid: currentOrg.Uid, Name: currentOrg.Name, UserUids: uid ? [uid] : [] });
      } else {
        const data: any = snap.data();
        const members: string[] = Array.isArray(data?.UserUids) ? data.UserUids : [];
        if (uid && !members.includes(uid)) {
          // Cannot update membership due to rules; surface a clear error
          this.snackBar.open('You are not a member of the selected organization in this environment. Re-select or create an org on the Org page.', 'Dismiss', { duration: 6000, verticalPosition: "top" });
          return;
        }
      }
    } catch (e) {
      // Non-fatal: continue to let save attempt report precise error
      console.warn('Org membership check failed', e);
    }
    // Only save valid rows
    const validRows = (this.excelData() || []).filter(r => !r.__invalid) as SampleInfo[];
    // Gather unique agents and ensure they exist or prompt for OELs
    const allAgents = Array.from(new Set(validRows.map(r => (r.Agent || '').trim()).filter(a => !!a)));
    if (allAgents.length) {
      // Load existing agents for defaults
      const orgId = currentOrg.Uid;
      let existing: Record<string, number> = {};
      try {
        const list$ = this.agentService.list(orgId);
        const list = await firstValueFrom(list$);
        existing = Object.fromEntries((list || []).map(a => [a.Name, a.OELNumber]));
      } catch { }
      // Only prompt for missing agents
      const missing = allAgents.filter(a => existing[a] === undefined);
      if (missing.length) {
        const dlg = this.dialog.open(AgentsDialogComponent, { data: { agents: missing, existing }, width: '520px' });
        const result = await dlg.afterClosed().toPromise();
        if (!result) {
          this.snackBar.open('Agent entry canceled.', 'Dismiss', { duration: 3000, verticalPosition: 'top' });
          return;
        }
        // Persist/merge agents to org subcollection
        for (const row of result) {
          if (!row?.Name) continue;
          try { await this.agentService.upsert(orgId, { Name: row.Name, OELNumber: Number(row.OELNumber) }); } catch { }
        }
      }
    }
    // Separate into exposure groups and save each group concurrently
    const grouped = this.exposureGroupservice.separateSampleInfoByExposureGroup(validRows);
    // Track recompute: snapshot the time and the doc ids that will be affected
    const startIso = new Date().toISOString();
    const ids = Object.keys(grouped).map(name => this.slugify(name));
    // Show progress snackbar
    const total = ids.length;
    // Use a persistent progress snackbar to avoid flashing on every tick
    let snackRef: any = null;
    const progress$ = new BehaviorSubject<{ done: number; total: number }>({ done: 0, total });
    if (total > 0) {
      const { ProgressSnackComponent } = await import('../../shared/progress-snack/progress-snack.component');
      snackRef = this.snackBar.openFromComponent(ProgressSnackComponent, { data: { label: 'Recomputing EF…', progress$ } });
    } else {
      snackRef = this.snackBar.open('Saving…');
    }
    try {
      await this.exposureGroupservice.saveGroupedSampleInfo(grouped, currentOrg.Uid, currentOrg.Name);
      // If there are no groups to recompute, finish early
      if (total === 0) {
        snackRef.dismiss();
        this.snackBar.open('Nothing to recompute.', 'OK', { duration: 2000, verticalPosition: "top" });
        return;
      }
      const res = await this.efTracker.waitForEf(
        currentOrg.Uid,
        ids,
        startIso,
        (done, totalCount) => {
          // Update progress subject; the snack component renders without reopening
          try { progress$.next({ done, total: totalCount }); } catch { }
        },
        60000
      );
      try { snackRef?.dismiss(); } catch { }
      if (res.timedOut) {
        this.snackBar.open('EF recompute is taking longer than expected. Values will appear when ready.', 'Dismiss', { duration: 5000 });
      } else {
        this.snackBar.open('EF recompute complete.', 'OK', { duration: 3000 });
      }
    } catch (e) {
      try { snackRef?.dismiss(); } catch { }
      this.snackBar.open('Save failed. Please try again.', 'Dismiss', { duration: 5000 });
      throw e;
    }
  }

  // Helpers
  private normalizeString(v: any): string {
    if (v === undefined || v === null) return '';
    return String(v).trim();
  }
  private tryParseNumber(v: any): number {
    if (v === undefined || v === null || v === '') return NaN;
    if (typeof v === 'number') return v;
    const cleaned = String(v).replace(/[^0-9.+-eE]/g, '');
    const num = parseFloat(cleaned);
    return Number.isFinite(num) ? num : NaN;
  }
  private parseDate(v: any): Date | null {
    if (!v && v !== 0) return null;
    // Already a Date
    if (v instanceof Date && !isNaN(v.getTime())) return v;
    // Excel serial number (days since 1899-12-30)
    if (typeof v === 'number' && isFinite(v)) {
      const base = new Date(Date.UTC(1899, 11, 30));
      const d = new Date(base.getTime() + v * 24 * 60 * 60 * 1000);
      return isNaN(d.getTime()) ? null : d;
    }
    // ISO or locale string
    const s = String(v).trim();
    // Common fixes: replace '/' with '-', enforce yyyy-mm-dd order if possible
    const tryDirect = new Date(s);
    if (!isNaN(tryDirect.getTime())) return tryDirect;
    // Attempt MM/DD/YYYY -> YYYY-MM-DD
    const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
      const mm = m[1].padStart(2, '0');
      const dd = m[2].padStart(2, '0');
      const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
      const iso = `${yyyy}-${mm}-${dd}`;
      const d = new Date(iso);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  private slugify(text: string): string {
    return (text || '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\-]/g, '')
      .replace(/-+/g, '-')
      .slice(0, 120);
  }
}
