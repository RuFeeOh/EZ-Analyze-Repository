import { Component, Inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

interface InvalidRowEditData {
  rows: {
    index: number; // original index in excelData array
    SampleNumber?: string;
    SampleDate?: string; // ISO string or empty
    ExposureGroup?: string;
    TWA?: number;
    Agent?: string;
    Notes?: string;
    __errors?: string[];
  }[];
}

@Component({
  selector: 'app-invalid-row-fix-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatInputModule, MatIconModule, MatTooltipModule],
  template: `
  <h2 mat-dialog-title>Fix Invalid Rows</h2>
  <div class="dialog-body">
    <p class="hint" *ngIf="edits().length === 0">No invalid rows to edit.</p>
    <div class="row-edit" *ngFor="let r of edits(); let i = index">
      <div class="row-head">Row {{ r.index + 1 }} <span class="errors" *ngIf="r.__errors?.length">{{ r.__errors.length }} issues</span></div>
      <div class="grid">
        <label>
          <span>Sample Date</span>
          <input type="date" [(ngModel)]="r.SampleDate" />
        </label>
        <label>
          <span>Sample Number *</span>
          <input type="text" [(ngModel)]="r.SampleNumber" />
        </label>
        <label>
          <span>Exposure Group *</span>
          <input type="text" [(ngModel)]="r.ExposureGroup" />
        </label>
        <label>
          <span>TWA *</span>
          <input type="number" step="0.0001" [(ngModel)]="r.TWA" />
        </label>
        <label>
          <span>Agent</span>
          <input type="text" [(ngModel)]="r.Agent" />
        </label>
        <label class="notes">
          <span>Notes</span>
          <input type="text" [(ngModel)]="r.Notes" />
        </label>
      </div>
    </div>
  </div>
  <div class="actions">
    <button mat-button (click)="close()">Cancel</button>
    <button matButton="filled" color="primary" (click)="apply()" [disabled]="!isValidAll()">Apply</button>
  </div>
  `,
  styles: [`
    :host { display:block; width:100%; max-width:760px; }
    .dialog-body { max-height:65vh; overflow:auto; padding:4px 4px 12px; }
    .row-edit { border:1px solid #304050; padding:12px 14px; border-radius:10px; margin-bottom:12px; background:#1d2329; }
    .row-head { font-weight:600; font-size:13px; margin-bottom:8px; display:flex; gap:8px; align-items:center; }
    .errors { background:#5e1e1e; color:#ffc1c1; padding:2px 8px; border-radius:12px; font-size:11px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap:12px; }
    label { display:flex; flex-direction:column; font-size:11px; text-transform:uppercase; letter-spacing:.5px; gap:4px; color:#b7c2cc; }
    input[type='text'], input[type='number'], input[type='date'] { background:#253039; border:1px solid #384650; color:#e6edf3; padding:6px 8px; border-radius:6px; font-size:13px; }
    input:focus { outline:2px solid #0d89c3; border-color:#0d89c3; }
    .notes { grid-column:1 / -1; }
    .actions { display:flex; justify-content:flex-end; gap:12px; margin-top:8px; }
  `]
})
export class InvalidRowFixDialogComponent {
  edits = signal<any[]>([]);
  constructor(@Inject(MAT_DIALOG_DATA) public data: InvalidRowEditData, private ref: MatDialogRef<InvalidRowFixDialogComponent>) {
    // Deep clone rows and normalize SampleDate to yyyy-MM-dd for date input binding
    const cloned = (data.rows || []).map(r => {
      const copy: any = { ...r };
      if (copy.SampleDate) {
        try {
          const d = new Date(copy.SampleDate);
          if (!isNaN(d.getTime())) {
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            copy.SampleDate = `${yyyy}-${mm}-${dd}`;
          }
        } catch { /* ignore */ }
      }
      return copy;
    });
    this.edits.set(cloned);
  }
  isValidAll() {
    return this.edits().every(r => {
      // required: ExposureGroup, TWA (>0), SampleDate parseable if provided
      const twaOk = r.TWA !== undefined && r.TWA !== null && r.TWA !== '' && !isNaN(Number(r.TWA)) && Number(r.TWA) > 0;
      const expOk = !!(r.ExposureGroup && r.ExposureGroup.trim());
      const snOk = !!(r.SampleNumber && r.SampleNumber.trim());
      // Allow blank date? Keep original logic: date required
      const dateOk = !!r.SampleDate;
      return twaOk && expOk && dateOk && snOk;
    });
  }
  apply() {
    // Convert date inputs (yyyy-MM-dd) back to ISO strings before returning
    const out = this.edits().map(r => {
      const copy = { ...r };
      if (copy.SampleDate) {
        try {
          const d = new Date(copy.SampleDate + 'T00:00:00');
          if (!isNaN(d.getTime())) copy.SampleDate = d.toISOString();
        } catch { }
      }
      return copy;
    });
    this.ref.close(out);
  }
  close() { this.ref.close(null); }
}
