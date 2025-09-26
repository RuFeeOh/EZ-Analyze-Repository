/// <reference lib="webworker" />
import * as XLSX from 'xlsx';

// Web Worker to parse XLSX workbook and rows off the main thread

// Types for messages
interface InitMessage {
    type: 'init';
    buffer: ArrayBuffer;
}
interface ReparseMessage {
    type: 'reparse';
    sheet: string;
    mapping: Record<string, string | null>;
}
interface CloseMessage { type: 'close'; }

type InMessage = InitMessage | ReparseMessage | CloseMessage;

type SampleInfo = {
    SampleNumber?: number;
    SampleDate: string;
    ExposureGroup: string;
    TWA?: number;
    Agent?: string;
    Notes?: string;
    __invalid?: boolean;
    __errors?: string[];
};

let workbook: any | null = null;

function normalizeString(v: any): string { if (v === undefined || v === null) return ''; return String(v).trim(); }
function tryParseNumber(v: any): number { if (v === undefined || v === null || v === '') return NaN; if (typeof v === 'number') return v; const cleaned = String(v).replace(/[^0-9.+-eE]/g, ''); const num = parseFloat(cleaned); return Number.isFinite(num) ? num : NaN; }
function parseDate(v: any): Date | null {
    if (!v && v !== 0) return null;
    if (v instanceof Date && !isNaN(v.getTime())) return v;
    if (typeof v === 'number' && isFinite(v)) { const base = new Date(Date.UTC(1899, 11, 30)); const d = new Date(base.getTime() + v * 86400000); return isNaN(d.getTime()) ? null : d; }
    const s = String(v).trim();
    const tryDirect = new Date(s); if (!isNaN(tryDirect.getTime())) return tryDirect;
    const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/); if (m) { const mm = m[1].padStart(2, '0'); const dd = m[2].padStart(2, '0'); const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3]; const iso = `${yyyy}-${mm}-${dd}`; const d = new Date(iso); return isNaN(d.getTime()) ? null : d; }
    return null;
}

function mapAndValidateRow(row: any, mapping: Record<string, string | null>): SampleInfo {
    const errors: string[] = [];
    const normalized: any = {} as SampleInfo;
    const getVal = (field: string) => { const header = mapping[field]; if (!header) return undefined; return row[header]; };
    const sampleNumber = tryParseNumber(getVal('SampleNumber'));
    normalized.SampleNumber = Number.isFinite(sampleNumber) ? (sampleNumber as number) : undefined;
    const exposureGroup = normalizeString(getVal('ExposureGroup'));
    if (!exposureGroup) errors.push('ExposureGroup is required');
    normalized.ExposureGroup = exposureGroup;
    const twaRaw = getVal('TWA');
    const twa = tryParseNumber(twaRaw);
    if (twaRaw === undefined || twaRaw === '') errors.push('TWA is required');
    else if (!Number.isFinite(twa)) errors.push('TWA must be a number');
    else if ((twa as number) <= 0) errors.push('TWA must be > 0');
    normalized.TWA = Number.isFinite(twa) ? (twa as number) : undefined;
    const sampleDateRaw = getVal('SampleDate');
    const parsedDate = parseDate(sampleDateRaw);
    if (!parsedDate) errors.push('SampleDate is required/invalid');
    normalized.SampleDate = parsedDate ? parsedDate.toISOString() : '';
    normalized.Agent = normalizeString(getVal('Agent'));
    normalized.Notes = normalizeString(getVal('Notes'));
    return { ...(normalized as any), __invalid: errors.length > 0, __errors: errors } as SampleInfo;
}

function getSheetHeaders(sheet: any): string[] {
    const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    if (!rows.length) return [];
    return rows[0].map(h => (h == null ? '' : String(h).trim()));
}

self.onmessage = (ev: MessageEvent<InMessage>) => {
    const msg = ev.data;
    if (msg.type === 'close') {
        self.close();
        return;
    }
    if (msg.type === 'init') {
        try {
            // Read workbook from buffer
            workbook = XLSX.read(msg.buffer, { type: 'array', cellDates: true });
            const sheetNames: string[] = workbook.SheetNames;
            const headersMap: Record<string, string[]> = {};
            for (const name of sheetNames) {
                headersMap[name] = getSheetHeaders(workbook.Sheets[name]);
            }
            const payload = { type: 'inited', sheetNames, headersMap } as const;
            (self as any).postMessage(payload);
        } catch (e: any) {
            (self as any).postMessage({ type: 'error', error: e?.message || String(e) });
        }
        return;
    }
    if (msg.type === 'reparse') {
        if (!workbook || !XLSX) { (self as any).postMessage({ type: 'error', error: 'Worker not initialized' }); return; }
        try {
            const sheet = workbook.Sheets[msg.sheet];
            if (!sheet) { (self as any).postMessage({ type: 'error', error: 'Sheet not found' }); return; }
            const rawRows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });
            const total = rawRows.length;
            const out: SampleInfo[] = new Array(total);
            const chunk = 1000;
            let done = 0;
            (self as any).postMessage({ type: 'progress', stage: 'Extracting rows', done, total });
            for (let i = 0; i < total; i += chunk) {
                const end = Math.min(i + chunk, total);
                for (let j = i; j < end; j++) {
                    out[j] = mapAndValidateRow(rawRows[j], msg.mapping);
                }
                done = end;
                const ratio = total > 0 ? (done / total) : 1;
                const stage = ratio < 0.33 ? 'Converting dates' : ratio < 0.85 ? 'Validating rows' : 'Preparing preview';
                (self as any).postMessage({ type: 'progress', stage, done, total });
            }
            (self as any).postMessage({ type: 'reparsed', rows: out });
        } catch (e: any) {
            (self as any).postMessage({ type: 'error', error: e?.message || String(e) });
        }
        return;
    }
};
