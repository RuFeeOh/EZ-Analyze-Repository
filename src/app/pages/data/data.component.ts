import { CommonModule } from '@angular/common';
import { Component, inject, computed, signal } from '@angular/core';
import * as XLSX from 'xlsx';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { SampleInfo } from '../../models/sample-info.model';
import { MatTableModule } from '@angular/material/table';
import { ExceedanceFractionService } from '../../services/exceedance-fraction/exceedance-fraction.service';
import { ExposureGroupService } from '../../services/exposure-group/exposure-group.service';
import { OrganizationService } from '../../services/organization/organization.service';
import { read } from 'xlsx';

@Component({
  selector: 'app-data',
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatTableModule,

  ],
  templateUrl: './data.component.html',
  styleUrl: './data.component.scss'
})
export class DataComponent {
  exceedanceFractionservice = inject(ExceedanceFractionService)
  exposureGroupservice = inject(ExposureGroupService)
  organizationservice = inject(OrganizationService)
  // Parsed + validated rows (SampleInfo with validation metadata)
  excelData: (SampleInfo & { __invalid?: boolean; __errors?: string[] })[] = [];
  exceedanceFraction!: number;
  columnsToDisplay = ['SampleNumber', 'SampleDate', 'ExposureGroup', 'TWA'];
  columnsToDisplayWithExpand = [...this.columnsToDisplay, 'Errors', 'expand'];
  expandedElement!: SampleInfo | null;
  invalidCount = signal(0);
  hasInvalidRows = computed(() => this.invalidCount() > 0);
  isExpanded(element: SampleInfo) {
    return this.expandedElement === element;
  }
  toggle(element: SampleInfo) {
    this.expandedElement = this.isExpanded(element) ? null : element;
  }
  onFileChange(event: any) {
    const file = event.target.files[0];
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

    this.excelData = parsed;
    this.invalidCount.set(parsed.filter(r => r.__invalid).length);
  }

  calculateExceedanceFraction() {
    //create a variable to separate the ExposureGroup column into an array
    const exposureGroups: {
      [key: string]: SampleInfo[];
    } = this.exposureGroupservice.separateSampleInfoByExposureGroup(this.excelData as SampleInfo[]);
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


    const TWAlist: number[] = this.exposureGroupservice.getTWAListFromSampleInfo(this.excelData as SampleInfo[]);
    this.exceedanceFraction = this.exceedanceFractionservice.calculateExceedanceProbability(TWAlist, 0.05);
  }

  async saveSampleInfo() {
    const currentOrg = this.organizationservice.currentOrg;
    if (!currentOrg) { throw new Error("No current organization") }
    // Only save valid rows
    const validRows = (this.excelData || []).filter(r => !r.__invalid) as SampleInfo[];
    // Separate into exposure groups and save each group concurrently
    const grouped = this.exposureGroupservice.separateSampleInfoByExposureGroup(validRows);
    await this.exposureGroupservice.saveGroupedSampleInfo(grouped, currentOrg.Uid, currentOrg.Name);
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
}
