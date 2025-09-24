import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

interface SheetOption {
    name: string;
    headers: string[];
    mapping: Record<string, string | null>;
    requiredMatches: number;
    recognized: number;
}
interface MappingData {
    // Backwards compatibility: if sheetOptions omitted, treat single sheet scenario
    headers?: string[];
    mapping?: Record<string, string | null>;
    sheetOptions?: SheetOption[];
    selected?: string; // pre-selected sheet name
    required: string[];
    optional: string[];
}

@Component({
    selector: 'app-column-mapping-dialog',
    standalone: true,
    imports: [CommonModule, FormsModule, MatButtonModule, MatSelectModule, MatIconModule, MatTooltipModule],
    template: `
  <h2 mat-dialog-title>Map Columns</h2>
  <div class="dialog-scroll" #scrollRoot>
  <div class="intro">
    <div class="legend">
      <span class="badge unmapped" *ngIf="unmappedCount() > 0" matTooltip="Still need to map required fields">{{ unmappedCount() }} unmapped required</span>
      <div class="spacer"></div>
      <div class="sheet-toolbar" *ngIf="multiSheet">
        <mat-select [(ngModel)]="selectedSheetName" (selectionChange)="onSheetChange()" class="sheet-dropdown" disableOptionCentering>
          <mat-option *ngFor="let s of data.sheetOptions" [value]="s.name">{{ s.name }} ({{ s.requiredMatches }}/{{ data.required.length }} req)</mat-option>
        </mat-select>
        <button mat-icon-button class="remap-btn" matTooltip="Re-run auto mapping" (click)="remapCurrent()"><mat-icon>refresh</mat-icon></button>
      </div>
    </div>
  </div>
  <div class="layout">
    <div class="pane form-pane">
      <div class="section">
  <div class="section-title">Required Fields <span class="stat" *ngIf="currentOption" matTooltip="Auto matched required columns">{{ currentOption.requiredMatches }}/{{ data.required.length }}</span></div>
        <div class="field-grid">
          <div class="field-row" *ngFor="let field of data.required" [class.missing]="!localMapping[field]">
            <div class="label">{{ field }} <span class="req-indicator" *ngIf="!localMapping[field]">*</span></div>
            <mat-select class="select" [(ngModel)]="localMapping[field]" disableOptionCentering panelClass="mapping-panel" placeholder="Select column">
              <mat-option [value]="null">-- None --</mat-option>
              <mat-option *ngFor="let h of (currentOption?.headers || data.headers || [])" [value]="h">{{ h || '(blank)' }}</mat-option>
            </mat-select>
          </div>
        </div>
      </div>
      <div class="section">
  <div class="section-title">Optional Fields <span class="stat" *ngIf="currentOption" matTooltip="Recognized optional columns">{{ currentOption.recognized - currentOption.requiredMatches }}</span></div>
        <div class="field-grid optional">
          <div class="field-row" *ngFor="let field of data.optional">
            <div class="label">{{ field }}</div>
            <mat-select class="select" [(ngModel)]="localMapping[field]" disableOptionCentering panelClass="mapping-panel" placeholder="Select column">
              <mat-option [value]="null">-- None --</mat-option>
              <mat-option *ngFor="let h of (currentOption?.headers || data.headers || [])" [value]="h">{{ h || '(blank)' }}</mat-option>
            </mat-select>
          </div>
        </div>
      </div>
    </div>
    <div class="pane headers-pane">
      <div class="headers-title">Sheet Headers</div>
      <div class="headers-list">
  <div class="header-chip" *ngFor="let h of (currentOption?.headers || data.headers || [])" [class.mapped]="isMapped(h)">{{ h || '(blank)' }}</div>
      </div>
      <div class="hint">Mapped headers highlighted. Unused stay neutral.</div>
    </div>
  </div>
  <div class="actions">
    <button mat-button (click)="close()">Cancel</button>
    <button matButton="filled" [disabled]="missingRequired()" (click)="confirm()">Continue</button>
  </div>
  </div>
  `,
    styles: [`
  :host { padding: 16px; display:block; width:100%; color:#f5f7fa; box-sizing:border-box; height:100%; }
  h2 { margin:0 0 .65rem; font-weight:600; color:#fafafa; padding-right:12px; }
  ::ng-deep .mat-mdc-dialog-surface { overflow:hidden; }
  .dialog-scroll { overflow-y:auto; overflow-x:hidden; padding-right:4px; }
    .intro { margin-bottom: .6rem; }
    .intro p { margin:0 0 .55rem; font-size:13px; line-height:1.4; color:#d0d4d9; }
  .legend { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }
  .legend .spacer { flex:1; }
  .sheet-toolbar { display:flex; align-items:center; gap:.35rem; }
  .remap-btn { width:36px; height:36px; line-height:36px; }
    .badge { font-size:11px; padding:2px 8px; border-radius:14px; background:#2f3742; color:#dde3ea; letter-spacing:.5px; text-transform:uppercase; font-weight:600; }
    .badge.required { background:#512da8; }
    .badge.optional { background:#05627a; }
    .badge.unmapped { background:#b71c1c; }
  .sheet-select { display:flex; align-items:center; gap:.75rem; margin:.4rem 0 1rem; }
  .sheet-select label { font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:#c5cad1; }
  .sheet-dropdown { width:260px; }
  .layout { display:flex; gap:1.4rem; min-width:0; }
  .pane { background:#181a1f; border:1px solid #2e3339; border-radius:12px; padding:1rem 1.15rem; position:relative; flex:1; min-height:320px; box-shadow:0 2px 4px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.02) inset; min-width:0; }
    .form-pane { flex:1.5; }
    .headers-pane { flex:1; display:flex; flex-direction:column; }
    .headers-title { font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.6px; color:#c5cad1; margin-bottom:.55rem; }
  .headers-list { display:flex; flex-wrap:wrap; gap:6px; overflow:auto; padding:4px 0; max-height:200px; }
    .header-chip { background:#242a31; padding:5px 9px; border-radius:8px; font-size:11px; line-height:1; border:1px solid #384048; color:#cdd3da; transition:background .15s, color .15s, border-color .15s; }
    .header-chip.mapped { background:#093a2f; border-color:#0fa97f; color:#b3ffe9; }
    .section { margin-bottom:1.35rem; }
  .section-title { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.55px; color:#9aa2ac; margin:0 0 .45rem; display:flex; align-items:center; gap:.5rem; }
  .section-title .mini { text-transform:none; letter-spacing:0; font-size:10px; font-weight:400; color:#7d858d; }
    .field-grid { display:flex; flex-direction:column; gap:.5rem; }
    .field-row { display:grid; grid-template-columns:160px 1fr; align-items:center; gap:.85rem; padding:.45rem .6rem; border:1px solid #30363d; border-radius:8px; background:#20252b; transition:border-color .15s, background .15s; }
    .field-row:hover { border-color:#3d444c; background:#262c33; }
    .field-row.missing { border-color:#a83a3a; background:#2c1b1d; }
    .label { font-size:13px; font-weight:500; color:#e2e6ea; letter-spacing:.3px; }
    .field-row.missing .label { color:#ffb3b3; }
    .req-indicator { color:#ff7676; font-weight:600; margin-left:4px; }
    .select { width:100%; --mat-select-panel-background-color:#1e2429; }
    .mat-mdc-select-value, .mat-mdc-select-arrow { color:#e5e9ed !important; }
    .headers-pane .hint { margin-top:auto; font-size:11px; color:#8a939c; }
  .actions { display:flex; justify-content:flex-end; gap:.85rem; margin-top:1.1rem; padding:0 4px 6px; position:sticky; bottom:0; background:linear-gradient(to bottom, rgba(24,26,31,0), #181a1f 60%); }
   
    @media (max-width:880px) { .layout { flex-direction:column; } .form-pane { flex:unset; }
      :host { min-width: unset; width:100%; }
    }
  `]
})
export class ColumnMappingDialogComponent {
    localMapping: Record<string, string | null> = {};
    multiSheet = false;
    selectedSheetName: string | null = null;
    currentOption: SheetOption | null = null;

    constructor(@Inject(MAT_DIALOG_DATA) public data: MappingData, private ref: MatDialogRef<ColumnMappingDialogComponent>) {
        // Determine multi-sheet scenario
        this.multiSheet = Array.isArray(data.sheetOptions) && data.sheetOptions.length > 0;
        if (this.multiSheet) {
            // Sort sheet options by requiredMatches desc then recognized desc
            data.sheetOptions!.sort((a, b) => {
                if (b.requiredMatches !== a.requiredMatches) return b.requiredMatches - a.requiredMatches;
                if (b.recognized !== a.recognized) return b.recognized - a.recognized;
                return a.name.localeCompare(b.name);
            });
            const initial = data.sheetOptions!.find(s => s.name === data.selected) || data.sheetOptions![0];
            this.applySheet(initial);
        } else {
            this.localMapping = { ...(data.mapping || {}) };
        }
    }
    private applySheet(opt: SheetOption) {
        this.currentOption = opt;
        this.selectedSheetName = opt.name;
        this.localMapping = { ...opt.mapping };
    }
    onSheetChange() {
        if (!this.data.sheetOptions) return;
        const found = this.data.sheetOptions.find(s => s.name === this.selectedSheetName);
        if (found) this.applySheet(found);
    }
    missingRequired() {
        return this.data.required.some(r => !this.localMapping[r]);
    }
    unmappedCount() { return this.data.required.filter(r => !this.localMapping[r]).length; }
    isMapped(header: string) { return Object.values(this.localMapping).includes(header); }
    close() { this.ref.close(); }
    confirm() { this.ref.close({ mapping: this.localMapping, sheet: this.selectedSheetName || (this.currentOption?.name) }); }

    remapCurrent() {
        if (!this.currentOption) return;
        const headers = this.currentOption.headers || this.data.headers || [];
        const lower = headers.map(h => h.toLowerCase());
        const synonyms: Record<string, string[]> = {
            SampleID: ['sample id', 'sampleid', 'id'],
            SampleDate: ['sample date', 'date', 'sampledate', 'collection date'],
            Analyte: ['analyte', 'substance', 'chemical'],
            TWA: ['twa', 'time weighted average', 'twa value'],
            Result: ['result', 'value', 'measurement'],
            Unit: ['unit', 'units']
        };
        // Clear existing
        for (const k of Object.keys(this.localMapping)) delete this.localMapping[k];
        const used = new Set<string>();
        const tryAssign = (target: string, variants: string[]) => {
            for (const v of variants) {
                const idx = lower.indexOf(v.toLowerCase());
                if (idx !== -1 && !used.has(headers[idx])) {
                    this.localMapping[target] = headers[idx];
                    used.add(headers[idx]);
                    return true;
                }
            }
            return false;
        };
        for (const req of this.data.required) {
            tryAssign(req, [req, ...(synonyms[req] || [])]);
        }
        for (const opt of this.data.optional) {
            if (!this.localMapping[opt]) tryAssign(opt, [opt, ...(synonyms[opt] || [])]);
        }
    }
}
