import { CommonModule } from '@angular/common';
import { Component, Inject, inject } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'app-new-agent-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, FormsModule, MatButtonModule],
  template: `
  <h2 mat-dialog-title>{{ data?.mode === 'edit' ? 'Edit Agent' : 'New Agent' }}</h2>
  <div mat-dialog-content>
    <div style="display:grid; grid-template-columns: 120px 1fr; gap:8px; align-items:center;">
      <label>Name</label>
      <input [(ngModel)]="model.Name" placeholder="Agent name" />
      <label>OEL</label>
      <input type="number" step="0.0001" min="0" [(ngModel)]="model.OELNumber" />
    </div>
  </div>
  <div mat-dialog-actions align="end">
    <button mat-button (click)="close()">Cancel</button>
    <button matButton="filled" (click)="save()">Save</button>
  </div>
  `,
})
export class NewAgentDialogComponent {
  private ref = inject(MatDialogRef) as MatDialogRef<NewAgentDialogComponent, { Name: string; OELNumber: number } | null>;
  model = { Name: '', OELNumber: 0.05 };
  constructor(@Inject(MAT_DIALOG_DATA) public data: any) {
    if (data?.agent) {
      this.model = { Name: data.agent.Name, OELNumber: data.agent.OELNumber };
    }
  }
  close() { this.ref.close(null); }
  save() {
    if (!this.model.Name.trim()) return;
    this.ref.close({ Name: this.model.Name.trim(), OELNumber: Number(this.model.OELNumber) });
  }
}
