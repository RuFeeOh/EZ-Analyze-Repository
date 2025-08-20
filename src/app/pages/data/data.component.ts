import { CommonModule } from '@angular/common';
import { Component, inject, computed, signal } from '@angular/core';
import * as XLSX from 'xlsx';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { SampleInfo } from '../../models/sample-info.model';
import { MatTableModule } from '@angular/material/table';
import { MatSnackBarModule } from '@angular/material/snack-bar';
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
import { BehaviorSubject } from 'rxjs';

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
  fileName = signal<string>('');
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
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      this.parseAndValidateWorkbook(workbook, firstSheetName);
      this.calculateExceedanceFraction();
    };
    fileReader.readAsArrayBuffer(file);

  }
  private parseAndValidateWorkbook(workbook: XLSX.WorkBook, sheetName: string) {
    const rawRows: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    const parsed: (SampleInfo & { __invalid?: boolean; __errors?: string[] })[] = rawRows.map((row, idx) => {
      const errors: string[] = [];
      const normalized: SampleInfo = new SampleInfo();
      // SampleNumber (optional)
      const sampleNumber = this.tryParseNumber(row['SampleNumber']);
      normalized.SampleNumber = Number.isFinite(sampleNumber) ? (sampleNumber as number) : 0;

      // ExposureGroup (required)
      const exposureGroup = this.normalizeString(row['ExposureGroup']);
      if (!exposureGroup) {
        errors.push('ExposureGroup is required');
      }
      normalized.ExposureGroup = exposureGroup;

      // TWA (required, numeric > 0)
      const twa = this.tryParseNumber(row['TWA']);
      if (!Number.isFinite(twa)) {
        errors.push('TWA must be a number');
      } else if ((twa as number) <= 0) {
        errors.push('TWA must be > 0');
      }
      normalized.TWA = Number.isFinite(twa) ? (twa as number) : 0;

      // SampleDate (required, robust parse, normalize to ISO)
      const sampleDateRaw = row['SampleDate'];
      const parsedDate = this.parseDate(sampleDateRaw);
      if (!parsedDate) {
        errors.push('SampleDate is required/invalid');
      }
      normalized.SampleDate = parsedDate ? parsedDate.toISOString() : '';

      // Agent/Notes (optional)
      normalized.Agent = this.normalizeString(row['Agent']);
      normalized.Notes = this.normalizeString(row['Notes']);

      const result = { ...(normalized as any), __invalid: errors.length > 0, __errors: errors } as SampleInfo & { __invalid?: boolean; __errors?: string[] };
      return result;
    });

    this.excelData.set(parsed);
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
