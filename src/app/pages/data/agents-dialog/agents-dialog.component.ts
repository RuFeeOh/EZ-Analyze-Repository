import { CommonModule } from '@angular/common';
import { Component, Inject, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { FormsModule } from '@angular/forms';

type AgentRow = { Name: string; OELNumber: number };

@Component({
    selector: 'app-agents-dialog',
    standalone: true,
    imports: [CommonModule, MatDialogModule, MatTableModule, MatButtonModule, FormsModule],
    template: `
  <h2 mat-dialog-title>Agents and OELs</h2>
  <div mat-dialog-content>

    <table mat-table [dataSource]="rows()" class="mat-elevation-z2">
      <ng-container matColumnDef="name">
        <th mat-header-cell *matHeaderCellDef>Agent</th>
        <td mat-cell *matCellDef="let r">{{ r.Name }}</td>
      </ng-container>
      <ng-container matColumnDef="oel">
        <th mat-header-cell *matHeaderCellDef>OEL</th>
        <td mat-cell *matCellDef="let r">
          <input type="number" step="0.0001" min="0" [(ngModel)]="r.OELNumber" style="width:120px;">
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
