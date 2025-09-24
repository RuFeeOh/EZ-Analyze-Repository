import { Injectable, inject } from '@angular/core';
import * as XLSX from 'xlsx';
import { SampleInfo } from '../../models/sample-info.model';
import { MatDialog } from '@angular/material/dialog';
import { InvalidRowFixDialogComponent } from './invalid-row-fix-dialog/invalid-row-fix-dialog.component';

export interface SheetOptionInfo {
    sheet: string;
    headers: string[];
    mapping: Record<string, string | null>;
    recognized: number;
    requiredMatches: number;
    parsed: (SampleInfo & { __invalid?: boolean; __errors?: string[] })[];
}

export interface ProcessResult {
    workbook: XLSX.WorkBook;
    sheetOptions: SheetOptionInfo[];
    primary: SheetOptionInfo;
    required: string[];
    optional: string[];
    allRequiredMapped: boolean;
}

@Injectable({
    providedIn: 'root'
})
export class UploadService {
    private dialog = inject(MatDialog);

    async processFile(file: File): Promise<ProcessResult> {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: 'array', cellDates: true });
        const required = ['SampleDate', 'ExposureGroup', 'TWA'];
        const optional = ['SampleNumber', 'Agent', 'Notes'];
        const sheetOptions: SheetOptionInfo[] = workbook.SheetNames.map(name => {
            const headers = this.getSheetHeaders(workbook, name);
            const mapping = this.computeAutoMapping(headers);
            const recognized = Object.values(mapping).filter(v => !!v).length;
            const requiredMatches = required.filter(r => !!mapping[r]).length;
            const parsed = this.parseRows(workbook, name, mapping);
            return { sheet: name, headers, mapping, recognized, requiredMatches, parsed };
        });
        sheetOptions.sort((a, b) => {
            if (b.requiredMatches !== a.requiredMatches) return b.requiredMatches - a.requiredMatches;
            if (b.recognized !== a.recognized) return b.recognized - a.recognized;
            return a.sheet.localeCompare(b.sheet);
        });
        const primary = sheetOptions[0];
        const allRequiredMapped = required.every(r => !!primary?.mapping[r]);
        return { workbook, sheetOptions, primary, required, optional, allRequiredMapped };
    }

    reparse(workbook: XLSX.WorkBook, sheet: string, mapping: Record<string, string | null>) {
        return this.parseRows(workbook, sheet, mapping);
    }

    fixInvalidRows(rows: (SampleInfo & { __invalid?: boolean; __errors?: string[] })[]) {
        const invalid = rows.map((r, i) => ({ ...r, index: i })).filter(r => r.__invalid);
        if (!invalid.length) return Promise.resolve(null);
        const dlg = this.dialog.open(InvalidRowFixDialogComponent, { data: { rows: invalid }, width: '720px', maxHeight: '80vh' });
        return dlg.afterClosed().toPromise();
    }

    validateExistingRow(row: any) {
        const errors: string[] = [];
        if (!row.ExposureGroup) errors.push('ExposureGroup is required');
        if (row.TWA === undefined || row.TWA === null || row.TWA === '') errors.push('TWA is required');
        else if (typeof row.TWA !== 'number' || !isFinite(row.TWA)) errors.push('TWA must be a number');
        else if (row.TWA <= 0) errors.push('TWA must be > 0');
        let parsed: Date | null = null;
        if (row.SampleDate) {
            parsed = new Date(row.SampleDate);
            if (isNaN(parsed.getTime())) parsed = null;
        }
        if (!parsed) errors.push('SampleDate is required/invalid');
        row.SampleDate = parsed ? parsed.toISOString() : '';
        row.__errors = errors;
        row.__invalid = errors.length > 0;
        return row;
    }

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
        const normalizedHeaders = headers.filter(h => h != null).map(h => {
            try { return { raw: h, norm: this.normalizeHeader(String(h)) }; } catch { return { raw: String(h ?? ''), norm: '' }; }
        }).filter(h => h && typeof h.norm === 'string');
        const lookup: Record<string, string> = {};
        for (const entry of normalizedHeaders) {
            if (!entry.norm) continue;
            if (lookup[entry.norm] === undefined) lookup[entry.norm] = entry.raw;
        }
        for (const field of Object.keys(mapping)) {
            const syns = synonyms[field] || [];
            for (const syn of syns) {
                if (lookup[syn] && !mapping[field]) { mapping[field] = lookup[syn]; break; }
            }
        }
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
        const getVal = (field: string) => { const header = mapping[field]; if (!header) return undefined; return row[header]; };
        const sampleNumber = this.tryParseNumber(getVal('SampleNumber'));
        normalized.SampleNumber = Number.isFinite(sampleNumber) ? (sampleNumber as number) : undefined;
        const exposureGroup = this.normalizeString(getVal('ExposureGroup'));
        if (!exposureGroup) errors.push('ExposureGroup is required');
        normalized.ExposureGroup = exposureGroup;
        const twaRaw = getVal('TWA');
        const twa = this.tryParseNumber(twaRaw);
        if (twaRaw === undefined || twaRaw === '') errors.push('TWA is required');
        else if (!Number.isFinite(twa)) errors.push('TWA must be a number');
        else if ((twa as number) <= 0) errors.push('TWA must be > 0');
        normalized.TWA = Number.isFinite(twa) ? (twa as number) : undefined;
        const sampleDateRaw = getVal('SampleDate');
        const parsedDate = this.parseDate(sampleDateRaw);
        if (!parsedDate) errors.push('SampleDate is required/invalid');
        normalized.SampleDate = parsedDate ? parsedDate.toISOString() : '';
        normalized.Agent = this.normalizeString(getVal('Agent'));
        normalized.Notes = this.normalizeString(getVal('Notes'));
        return { ...(normalized as any), __invalid: errors.length > 0, __errors: errors };
    }
    private normalizeString(v: any): string { if (v === undefined || v === null) return ''; return String(v).trim(); }
    private tryParseNumber(v: any): number { if (v === undefined || v === null || v === '') return NaN; if (typeof v === 'number') return v; const cleaned = String(v).replace(/[^0-9.+-eE]/g, ''); const num = parseFloat(cleaned); return Number.isFinite(num) ? num : NaN; }
    private parseDate(v: any): Date | null {
        if (!v && v !== 0) return null;
        if (v instanceof Date && !isNaN(v.getTime())) return v;
        if (typeof v === 'number' && isFinite(v)) { const base = new Date(Date.UTC(1899, 11, 30)); const d = new Date(base.getTime() + v * 86400000); return isNaN(d.getTime()) ? null : d; }
        const s = String(v).trim();
        const tryDirect = new Date(s); if (!isNaN(tryDirect.getTime())) return tryDirect;
        const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/); if (m) { const mm = m[1].padStart(2, '0'); const dd = m[2].padStart(2, '0'); const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3]; const iso = `${yyyy}-${mm}-${dd}`; const d = new Date(iso); return isNaN(d.getTime()) ? null : d; }
        return null;
    }
}