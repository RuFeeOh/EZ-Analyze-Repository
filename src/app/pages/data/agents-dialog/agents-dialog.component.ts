import { CommonModule } from '@angular/common';
import { Component, Inject, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';

type AgentRow = { Name: string; OELNumber: number };

@Component({
  selector: 'app-agents-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatTableModule, MatButtonModule, FormsModule, MatInputModule, MatFormFieldModule],
  styles: [
    `:host { display: block; }
     table.agents-table { width: 100%; border-collapse: separate; border-spacing: 0; }
     /* Increase vertical rhythm for headers and cells */
     .agents-table .mat-mdc-header-cell, .agents-table .mat-mdc-cell { padding: 14px 16px; }
     /* Subtle divider between rows for visual separation */
     .agents-table .mat-mdc-row:not(:last-child) .mat-mdc-cell { border-bottom: 1px solid rgba(255,255,255,0.12); }
     /* Column sizing */
     .agents-table .mat-column-name { width: 60%; white-space: normal; }
     .agents-table .mat-column-oel { width: 40%; }
     /* Form field sizing within cell */
     .agents-table .oel-field { width: 200px; max-width: 100%; margin: 4px 0; }
     /* On narrow screens, let input grow full width */
     @media (max-width: 640px) {
       .agents-table .oel-field { width: 100%; }
     }
    `
  ],
  template: `
  <h2 mat-dialog-title>Agents and OELs</h2>
  <div mat-dialog-content>

    <table mat-table [dataSource]="rows()" class="mat-elevation-z2 agents-table">
      <ng-container matColumnDef="name">
        <th mat-header-cell *matHeaderCellDef>Agent</th>
        <td mat-cell *matCellDef="let r">{{ r.Name }}</td>
      </ng-container>
      <ng-container matColumnDef="oel">
        <th mat-header-cell *matHeaderCellDef>OEL</th>
        <td mat-cell *matCellDef="let r">
          <mat-form-field appearance="outline" class="oel-field">
            <mat-label>OEL</mat-label>
            <input matInput type="number" step="0.0001" min="0" [(ngModel)]="r.OELNumber" />
          </mat-form-field>
        </td>
      </ng-container>
      <tr mat-header-row *matHeaderRowDef="['name','oel']"></tr>
      <tr mat-row *matRowDef="let row; columns: ['name','oel'];"></tr>
    </table>
  </div>
  <div mat-dialog-actions align="end">
    <button mat-button (click)="close()">Cancel</button>
    <button mat-raised-button color="primary" (click)="save()">Save</button>
  </div>
  `,
})
export class AgentsDialogComponent {
  private ref = inject(MatDialogRef) as MatDialogRef<AgentsDialogComponent, AgentRow[]>;
  rows = signal<AgentRow[]>([]);
  constructor(@Inject(MAT_DIALOG_DATA) data: { agents: string[]; existing: Record<string, number> }) {
    const unique = Array.from(new Set((data?.agents || []).filter(a => !!a).map(a => a.trim())));
    const rows = unique.map(name => ({ Name: name, OELNumber: data?.existing?.[name] ?? 0.05 }));
    this.rows.set(rows);
  }
  close() { this.ref.close(); }
  save() { this.ref.close(this.rows()); }
}
