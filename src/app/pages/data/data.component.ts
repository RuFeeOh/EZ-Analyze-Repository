import { CommonModule } from '@angular/common';
import { Component, inject, computed, signal } from '@angular/core';
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
import { Firestore } from '@angular/fire/firestore';
import { Auth } from '@angular/fire/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { EfRecomputeTrackerService } from '../../services/exceedance-fraction/ef-recompute-tracker.service';
import { SnackService } from '../../services/ui/snack.service';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { AgentsDialogComponent } from './agents-dialog/agents-dialog.component';
import { AgentService } from '../../services/agent/agent.service';
import { ColumnMappingDialogComponent } from './column-mapping-dialog/column-mapping-dialog.component';
import { UploadService, SheetOptionInfo } from './upload.service';
import { DataService } from './data.service';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
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
    MatProgressSpinnerModule,
    MatProgressBarModule,

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
  private upload = inject(UploadService)
  private dataService = inject(DataService)
  fileName = signal<string>('');
  // Loading state for file processing
  isParsing = signal<boolean>(false);
  parsePercent = signal<number | null>(null);
  parseLabel = signal<string>('');
  // Stored last mapping state for manual reopen
  private lastWorkbook: any = null;
  private lastSheetOptions: SheetOptionInfo[] = [];
  private lastRequired: string[] = [];
  private lastOptional: string[] = [];
  private lastSelectedSheet: string | null = null;
  private lastFinalMapping: Record<string, string | null> | null = null;
  // Parsed + validated rows (SampleInfo with validation metadata)
  excelData = signal<(SampleInfo & { __invalid?: boolean; __errors?: string[] })[]>([]);
  exceedanceFraction!: number;
  columnsToDisplay = ['SampleNumber', 'SampleDate', 'ExposureGroup', 'TWA', 'Agent'];
  columnsToDisplayWithExpand = [...this.columnsToDisplay, 'Errors'];
  expandedElement!: SampleInfo | null;
  invalidCount = computed(() => this.excelData().filter(r => r.__invalid).length);
  hasInvalidRows = computed(() => this.invalidCount() > 0);
  totalCount = computed(() => this.excelData().length);
  validCount = computed(() => this.excelData().filter(r => !r.__invalid).length);
  invalidCellCount = computed(() => this.excelData().reduce((acc, r) => acc + ((r.__errors || []).length), 0));
  // Display data with invalid rows first (stable order within groups)
  displayData = computed(() => {
    const rows = this.excelData();
    return rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        // Priority: invalid (0), recently fixed (1), valid normal (2)
        const rank = (x: any) => x.r.__invalid ? 0 : (x.r.__recentFixed ? 1 : 2);
        const ra = rank(a); const rb = rank(b);
        if (ra !== rb) return ra - rb;
        return a.i - b.i;
      })
      .map(x => x.r);
  });
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
  async onFileChange(event: any) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.name) this.fileName.set(file.name);
    this.isParsing.set(true);
    this.parsePercent.set(0);
    this.parseLabel.set('Reading file…');
    const result = await this.upload.processFile(file, (p, label) => {
      this.parsePercent.set(p);
      if (label) this.parseLabel.set(label);
    }).finally(() => {
      this.isParsing.set(false);
    });
    this.lastWorkbook = result.workbook;
    this.lastSheetOptions = result.sheetOptions;
    this.lastRequired = result.required;
    this.lastOptional = result.optional;
    this.lastSelectedSheet = result.primary?.sheet || null;
    this.lastFinalMapping = result.primary?.mapping || null;
    if (!result.primary || result.primary.parsed.length === 0) {
      this.excelData.set([]);
      this.snackBar.open('No sheets contained recognizable data. Please check your file.', 'Dismiss', { duration: 6000, verticalPosition: 'top' });
      return;
    }
    if (result.allRequiredMapped) {
      this.excelData.set(result.primary.parsed as any);
      this.calculateExceedanceFraction();
      return;
    }
    const dlgRef = this.dialog.open(ColumnMappingDialogComponent, {
      data: {
        sheetOptions: result.sheetOptions.map(s => ({ name: s.sheet, headers: s.headers, mapping: s.mapping, requiredMatches: s.requiredMatches, recognized: s.recognized })),
        selected: result.primary.sheet,
        required: result.required,
        optional: result.optional
      }, width: '60vw', maxWidth: '60vw', maxHeight: '75vh', panelClass: 'mapping-dialog-panel'
    });
    dlgRef.afterClosed().subscribe(async res => {
      if (!res) { this.snackBar.open('Import canceled.', 'Dismiss', { duration: 3000, verticalPosition: 'top' }); return; }
      const chosenName = res.sheet || result.primary.sheet;
      const chosen = result.sheetOptions.find(s => s.sheet === chosenName) || result.primary;
      const finalMapping = res.mapping || chosen.mapping;
      // Use worker-based reparse if available to keep UI responsive
      const reparsed = this.upload.reparseBuffered ? await this.upload.reparseBuffered(chosen.sheet, finalMapping) : this.upload.reparse(result.workbook, chosen.sheet, finalMapping);
      const stillMissing = result.required.filter(r => !finalMapping[r]);
      if (stillMissing.length) { this.snackBar.open('Missing required columns: ' + stillMissing.join(', '), 'Dismiss', { duration: 6000, verticalPosition: 'top' }); return; }
      this.excelData.set(reparsed as any);
      this.lastSelectedSheet = chosen.sheet;
      this.lastFinalMapping = finalMapping;
      this.calculateExceedanceFraction();
    });
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
    dlgRef.afterClosed().subscribe(async result => {
      if (!result) return;
      const chosenName = result.sheet || primary.sheet;
      const chosen = sheetOptions.find(s => s.sheet === chosenName) || primary;
      const finalMapping = result.mapping || chosen.mapping;
      const reparsed = this.upload.reparseBuffered ? await this.upload.reparseBuffered(chosen.sheet, finalMapping) : this.upload.reparse(workbook, chosen.sheet, finalMapping);
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

  openFixInvalidRows() {
    const rows = this.excelData();
    const invalid = rows
      .map((r, i) => ({ ...r, index: i }))
      .filter(r => r.__invalid);
    if (!invalid.length) return;
    this.upload.fixInvalidRows(rows as any).then(result => {
      if (!result) return;
      const updated = [...this.excelData()].map(r => ({ ...r, __recentFixed: false }));
      for (const edit of result) {
        const idx = edit.index;
        if (idx < 0 || idx >= updated.length) continue;
        const current = { ...updated[idx] } as any;
        current.SampleDate = edit.SampleDate ? new Date(edit.SampleDate).toISOString() : '';
        current.ExposureGroup = (edit.ExposureGroup || '').trim();
        current.TWA = edit.TWA !== undefined && edit.TWA !== null && edit.TWA !== '' ? Number(edit.TWA) : undefined;
        current.Agent = edit.Agent || current.Agent;
        current.Notes = edit.Notes || current.Notes;
        const validated = this.upload.validateExistingRow(current);
        validated.__recentFixed = !validated.__invalid; // mark only if now valid
        updated[idx] = validated as any;
      }
      this.excelData.set(updated as any);
      this.calculateExceedanceFraction();
    });
  }


  async saveSampleInfo() {
    const validRows = (this.excelData() || []).filter(r => !r.__invalid) as SampleInfo[];
    await this.dataService.save({ validRows });
  }
}
