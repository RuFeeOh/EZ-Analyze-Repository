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
    private workbookBuffer: ArrayBuffer | null = null;
    private worker: Worker | null = null;

    async processFile(file: File, onProgress?: (percent: number | null, label?: string) => void): Promise<ProcessResult> {
        // Progress orchestrator: 3 sections [0-33, 33-66, 66-100]
        const prog = this.createProgressOrchestrator(onProgress);
        prog.startSection(0, 33, [
            'Preparing reader…',
            'Opening file…',
            'Allocating buffers…',
            'Estimating size…',
            'Starting read…',
            'Reading data…',
            'Reading chunks…',
            'Processing chunk…',
            'Merging chunks…',
            'Buffering…',
            'Tracking progress…',
            'Detecting file type…',
            'Validating file…',
            'Checking extension…',
            'Processing stream…',
            'Awaiting I/O…',
            'Stabilizing stream…',
            'Optimizing throughput…',
            'Handling large file…',
            'Finalizing read…',
            'Flushing buffers…',
            'Closing handle…',
            'Almost there…',
            'Ready to parse…'
        ]);
        const data = await this.readFileWithProgress(file, (p) => {
            // Map raw reader percent (0..95) into section 0 (0..32) as target
            prog.setSectionTargetFraction(Math.min(0.95, Math.max(0, (p || 0) / 100)));
        });
        // Gate to 33% at reader completion
        prog.completeSection('Querying workbook…');
        this.workbookBuffer = data;
        let worker: Worker | null = null;
        try {
            worker = this.getWorker();
            await this.initWorker(worker, data);
        } catch (e) {
            // Worker init failed; we'll fall back to main-thread parsing
            worker = null;
        }
        // Section 2: Reading workbook & headers (33-66)
        prog.startSection(33, 66, ['Parsing workbook…', 'Scanning sheets…', 'Finding correct mappings…', 'Validating headers…']);
        const workbook = XLSX.read(data, { type: 'array', cellDates: true });
        const required = ['SampleDate', 'ExposureGroup', 'TWA'];
        const optional = ['SampleNumber', 'Agent', 'Notes'];
        prog.bumpLabel('Scanning sheets…');
        const sheetOptions: SheetOptionInfo[] = workbook.SheetNames.map(name => {
            const headers = this.getSheetHeaders(workbook, name);
            const mapping = this.computeAutoMapping(headers);
            const recognized = Object.values(mapping).filter(v => !!v).length;
            const requiredMatches = required.filter(r => !!mapping[r]).length;
            // Defer parsing rows for non-primary sheets to speed up initial load
            return { sheet: name, headers, mapping, recognized, requiredMatches, parsed: [] as any };
        });
        prog.bumpLabel('Finding correct mappings…');
        sheetOptions.sort((a, b) => {
            if (b.requiredMatches !== a.requiredMatches) return b.requiredMatches - a.requiredMatches;
            if (b.recognized !== a.recognized) return b.recognized - a.recognized;
            return a.sheet.localeCompare(b.sheet);
        });
        const primary = sheetOptions[0];
        prog.bumpLabel('Validating headers…');
        const allRequiredMapped = required.every(r => !!primary?.mapping[r]);
        // Done with headers -> gate to 66%
        prog.completeSection('Headers validated');
        // Par  se rows only for primary sheet now (chunked for responsiveness if onProgress provided)
        if (primary) {
            if (onProgress) {
                // Section 3: Rendering rows (66-100)
                prog.startSection(66, 100, ['Rendering rows…', 'Converting dates…', 'Validating rows…', 'Preparing preview…']);
                let rows: any[] | null = null;
                if (worker) {
                    try {
                        rows = await this.reparseWithWorker(worker, primary.sheet, primary.mapping, (done, total, stage) => {
                            const frac = total > 0 ? (done / total) : 1;
                            prog.setSectionTargetFraction(frac, stage ? `${stage}… ${done}/${total}` : `Rendering rows… ${done}/${total}`);
                        });
                    } catch {
                        rows = null;
                    }
                }
                if (!rows) {
                    // Fallback to main-thread chunked parsing
                    rows = await this.parseRowsChunked(workbook, primary.sheet, primary.mapping, (done, total, stage) => {
                        const frac = total > 0 ? (done / total) : 1;
                        prog.setSectionTargetFraction(frac, stage ? `${stage}… ${done}/${total}` : `Reading rows… ${done}/${total}`);
                    });
                }
                primary.parsed = rows as any;
                prog.finish('Done');
            } else {
                primary.parsed = this.parseRows(workbook, primary.sheet, primary.mapping) as any;
            }
        }
        return { workbook, sheetOptions, primary, required, optional, allRequiredMapped };
    }

    reparse(workbook: XLSX.WorkBook, sheet: string, mapping: Record<string, string | null>) {
        return this.parseRows(workbook, sheet, mapping);
    }

    // New: Use worker with stored buffer for reparse to avoid blocking main thread
    async reparseBuffered(sheet: string, mapping: Record<string, string | null>, onChunk?: (done: number, total: number, stage?: string) => void) {
        if (!this.workbookBuffer) throw new Error('No workbook buffer available');
        try {
            const worker = this.getWorker();
            return await this.reparseWithWorker(worker, sheet, mapping, onChunk);
        } catch {
            // Fallback: parse on main thread from stored buffer
            const wb = XLSX.read(this.workbookBuffer, { type: 'array', cellDates: true });
            return await this.parseRowsChunked(wb, sheet, mapping, onChunk);
        }
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

    // Chunked row parsing to keep UI responsive on large files
    private async parseRowsChunked(
        workbook: XLSX.WorkBook,
        sheetName: string,
        mapping: Record<string, string | null>,
        onChunk?: (done: number, total: number, stage?: string) => void
    ) {
        const rawRows: any[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
        const total = rawRows.length;
        const out: (SampleInfo & { __invalid?: boolean; __errors?: string[] })[] = new Array(total);
        const chunk = 500;
        let done = 0;
        // Initial extraction stage
        onChunk?.(0, total, 'Extracting rows');
        for (let i = 0; i < total; i += chunk) {
            const end = Math.min(i + chunk, total);
            for (let j = i; j < end; j++) {
                out[j] = this.mapAndValidateRow(rawRows[j], mapping) as any;
            }
            done = end;
            // Stage hint based on progress
            const ratio = total > 0 ? (done / total) : 1;
            const stage = ratio < 0.33 ? 'Converting dates'
                : ratio < 0.85 ? 'Validating rows'
                    : 'Preparing preview';
            onChunk?.(done, total, stage);
            // Yield to the event loop so the UI can update
            await new Promise(res => setTimeout(res, 0));
        }
        return out;
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

    private async readFileWithProgress(file: File, onProgress?: (percent: number | null, label?: string) => void): Promise<ArrayBuffer> {
        return new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            let simulatedTimer: any = null;
            const startTs = Date.now();

            const update = (percentGuess: number) => {
                const clamped = Math.max(1, Math.min(95, Math.floor(percentGuess)));
                onProgress?.(clamped, 'Uploading file…');
            };

            const startSim = () => {
                let sim = 1;
                simulatedTimer = setInterval(() => {
                    sim = Math.min(sim + 2, 90); // move forward gently
                    update(sim);
                }, 350);
            };
            const stopSim = () => { if (simulatedTimer) { clearInterval(simulatedTimer); simulatedTimer = null; } };

            reader.onprogress = (e: ProgressEvent<FileReader>) => {
                if (e.lengthComputable) {
                    const percent = Math.min(95, Math.floor((e.loaded / Math.max(1, e.total)) * 95));
                    update(percent);
                }
            };
            reader.onloadstart = () => { startSim(); };
            reader.onerror = () => {
                stopSim();
                reject(reader.error || new Error('Failed to read file'));
            };
            reader.onload = () => {
                stopSim();
                resolve(reader.result as ArrayBuffer);
            };
            reader.readAsArrayBuffer(file);
        });
    }

    // Progress Orchestrator: ensures
    // - 3 sections: [start, end] = [0-33, 33-66, 66-100]
    // - each section takes at least 1s
    // - bar moves at least every 300ms
    private createProgressOrchestrator(onProgress?: (percent: number | null, label?: string) => void) {
        const MIN_SECTION_MS = 1000;
        const MAX_IDLE_MS = 300;
        const TICK_MS = 150;
        let currentStart = 0;
        let currentEnd = 33;
        let currentLabel = '';
        let labels: string[] = [];
        let labelIdx = 0;
        let sectionStartTs = Date.now();
        let lastMoveTs = 0;
        let percent = 0;
        let targetAbs = 0;
        let finished = false;
        let gateMax = currentEnd - 1; // prevent reaching end until completeSection
        let timer: any = null;

        const emit = () => { onProgress?.(Math.min(100, Math.floor(percent)), currentLabel); };
        const rotateLabel = () => { if (labels.length) { currentLabel = labels[labelIdx % labels.length]; labelIdx++; } };
        const startTick = () => {
            if (timer) return;
            timer = setInterval(() => {
                if (finished) { clearInterval(timer); timer = null; return; }
                const now = Date.now();
                // time-allowed cap within section
                const elapsed = now - sectionStartTs;
                const span = currentEnd - currentStart;
                const timeBaseline = currentStart + Math.min(1, elapsed / MIN_SECTION_MS) * span;
                // Allow progress to follow either real target or time-based baseline, but never exceed gateMax
                const allowed = Math.min(gateMax, Math.max(targetAbs, timeBaseline));
                // ensure move at least every MAX_IDLE_MS
                if (now - lastMoveTs >= MAX_IDLE_MS && percent < allowed) {
                    percent = Math.min(allowed, percent + 1);
                    lastMoveTs = now;
                    emit();
                } else if (percent < allowed) {
                    // nudge smaller increments too
                    percent = Math.min(allowed, percent + 0.5);
                    lastMoveTs = now;
                    emit();
                } else {
                    // even if at cap, rotate label for perceived progress
                    rotateLabel();
                    emit();
                }
            }, TICK_MS);
        };

        const toAbs = (fraction: number) => currentStart + Math.max(0, Math.min(1, fraction)) * (currentEnd - currentStart);

        return {
            startSection(start: number, end: number, sectionLabels: string[]) {
                currentStart = start; currentEnd = end; labels = sectionLabels || []; labelIdx = 0; sectionStartTs = Date.now(); gateMax = end - 1; currentLabel = labels[0] || currentLabel; targetAbs = Math.max(targetAbs, start);
                // Jump percent up to at least start
                if (percent < start) { percent = start; lastMoveTs = Date.now(); emit(); }
                startTick();
            },
            setSectionTargetFraction(frac: number, label?: string) {
                if (label) currentLabel = label;
                const abs = toAbs(frac);
                targetAbs = Math.max(targetAbs, abs);
            },
            bumpLabel(label: string) { currentLabel = label; rotateLabel(); emit(); },
            completeSection(finalLabel?: string) {
                currentLabel = finalLabel || currentLabel;
                gateMax = currentEnd; // allow reaching end of section
                targetAbs = Math.max(targetAbs, currentEnd);
                // ensure at least MIN_SECTION_MS elapsed
                const remaining = MIN_SECTION_MS - (Date.now() - sectionStartTs);
                if (remaining > 0) { setTimeout(() => { percent = currentEnd; lastMoveTs = Date.now(); emit(); }, remaining); }
                else { percent = currentEnd; lastMoveTs = Date.now(); emit(); }
            },
            finish(finalLabel?: string) {
                // Respect min section time; smoothly reach the end of this section (which is 100 in the last phase)
                currentLabel = finalLabel || currentLabel || 'Done';
                gateMax = currentEnd; // allow reaching end
                targetAbs = Math.max(targetAbs, currentEnd);
                const remaining = MIN_SECTION_MS - (Date.now() - sectionStartTs);
                if (remaining > 0) {
                    setTimeout(() => {
                        percent = currentEnd;
                        lastMoveTs = Date.now();
                        emit();
                        finished = true;
                    }, remaining);
                } else {
                    percent = currentEnd;
                    lastMoveTs = Date.now();
                    emit();
                    finished = true;
                }
            }
        };
    }

    // Worker helpers
    private getWorker(): Worker {
        if (this.worker) return this.worker;
        // Use new URL syntax so Angular builder can bundle the worker
        this.worker = new Worker(new URL('./upload.worker', import.meta.url), { type: 'module' });
        return this.worker;
    }
    private async initWorker(worker: Worker, buffer: ArrayBuffer): Promise<Record<string, string[]>> {
        return new Promise((resolve, reject) => {
            const onMessage = (ev: MessageEvent<any>) => {
                const data = ev.data;
                if (data?.type === 'inited') {
                    worker.removeEventListener('message', onMessage);
                    resolve(data.headersMap as Record<string, string[]>);
                } else if (data?.type === 'error') {
                    worker.removeEventListener('message', onMessage);
                    reject(new Error(data.error || 'Worker init failed'));
                }
            };
            worker.addEventListener('message', onMessage);
            // Do not transfer the buffer so the main thread can still read it
            worker.postMessage({ type: 'init', buffer });
        });
    }
    private async reparseWithWorker(worker: Worker, sheet: string, mapping: Record<string, string | null>, onChunk?: (done: number, total: number, stage?: string) => void) {
        return new Promise<any[]>((resolve, reject) => {
            const onMessage = (ev: MessageEvent<any>) => {
                const data = ev.data;
                if (data?.type === 'progress') {
                    onChunk?.(data.done, data.total, data.stage);
                } else if (data?.type === 'reparsed') {
                    worker.removeEventListener('message', onMessage);
                    resolve(data.rows);
                } else if (data?.type === 'error') {
                    worker.removeEventListener('message', onMessage);
                    reject(new Error(data.error || 'Worker reparse failed'));
                }
            };
            worker.addEventListener('message', onMessage);
            worker.postMessage({ type: 'reparse', sheet, mapping });
        });
    }
}