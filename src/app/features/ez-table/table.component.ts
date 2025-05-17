import { Component, computed, input, Signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { EzTableColumn } from '../../models/ez-table-column.model';

@Component({
    selector: 'ez-table',
    standalone: true,
    imports: [CommonModule, MatTableModule, MatIconModule, MatButtonModule],
    templateUrl: './table.component.html',
    styleUrls: ['./table.component.scss']
})
export class TableComponent {
    data = input<any[]>([]);
    columns = input<EzTableColumn[]>([]);
    expandable = input<boolean>(false);

    displayedColumns: Signal<EzTableColumn[]> = computed(() => {
        const cols = this.columns() || []; // Ensure columns is defined
        return this.expandable() ? [...cols, this.expandColumn] : cols;
    });
    displayedColumnsDisplayName: Signal<string[]> = computed(() => {
        const cols = this.displayedColumns();
        return cols.map((col) => col.DisplayName);
    });

    readonly expandColumn = new EzTableColumn({
        Name: 'expand',
        DisplayName: 'expand',
        Type: 'string'
    });

    isExpanded(element: any): boolean {
        return element.expanded || false;
    }

    toggle(element: any): void {
        element.expanded = !element.expanded;
    }
}
