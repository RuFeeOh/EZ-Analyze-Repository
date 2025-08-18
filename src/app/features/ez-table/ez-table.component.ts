import { AfterViewInit, Component, computed, input, signal, ViewChild, WritableSignal } from '@angular/core';
import { MatPaginator, MatPaginatorModule } from '@angular/material/paginator';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { CommonModule } from '@angular/common';
import { ExposureGroup } from '../../models/exposure-group.model';
import { SampleInfo } from '../../models/sample-info.model';
import { ExposureGroupTableItem } from '../../models/exposure-group-table-item.model';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { EzColumn } from '../../models/ez-column.model';

@Component({
  selector: 'ez-table',
  imports: [
    CommonModule,
    MatTableModule,
    MatPaginatorModule,
    MatIconModule,
    MatButtonModule,
  ],
  templateUrl: './ez-table.component.html',
  styleUrl: './ez-table.component.scss'
})
export class EzTableComponent implements AfterViewInit {
  // Accept either simple string keys or EzColumn models
  displayedColumns = input<(string | EzColumn)[]>(['SampleDate', 'ExposureGroup', 'TWA', 'Notes', 'SampleNumber'])
  data = input<ExposureGroup[]>([]);
  dataResults = input<SampleInfo[]>([]);
  // Controls where the expanded details pull from: group.Results or LatestExceedanceFraction.ResultsUsed
  detailSource = input<'group' | 'ef'>('group');

  @ViewChild(MatPaginator) paginator!: MatPaginator;
  paginatorSignal: WritableSignal<MatPaginator | null> = signal(null);
  // Resolve string IDs for columns to satisfy MatTable APIs
  columnIds = computed(() => (this.displayedColumns() ?? []).map(c => typeof c === 'string' ? c : c.Name));
  // DataSource for flat SampleInfo rows mode
  dataTableSource = computed(() => {
    let mappedData = [];
    if (this.data().length) {
      mappedData = this.mapExposureGroupsToTableItems(this.data());
    } else {
      mappedData = this.mapResultsToTableItems(this.dataResults() ?? []);
    }
    const dataSource = new MatTableDataSource<ExposureGroupTableItem>(mappedData);
    if (this.paginatorSignal()) {
      dataSource.paginator = this.paginatorSignal();
    }
    return dataSource;
  });

  // DataSource for group rows (expandable)
  groupTableSource = computed(() => {
    const groups = this.data() ?? [];
    const dataSource = new MatTableDataSource<ExposureGroup>(groups);
    if (this.paginatorSignal()) {
      dataSource.paginator = this.paginatorSignal();
    }
    return dataSource;
  });

  // Columns for the group table (expand + summary columns)
  readonly groupColumns: string[] = ['expand', 'ExposureGroup', 'Samples', 'LatestEF'];

  expandedGroup: ExposureGroup | null = null;

  ngAfterViewInit() {
    this.paginatorSignal.set(this.paginator);
  }

  private mapExposureGroupsToTableItems(exposureGroups: ExposureGroup[]): ExposureGroupTableItem[] {
    const mappedGroups: ExposureGroupTableItem[] = exposureGroups.map(group => {
      const results = group.Results;
      return this.mapResultsToTableItems(results);
    }).flat();
    return mappedGroups;
  }

  private mapResultsToTableItems(results: SampleInfo[]): ExposureGroupTableItem[] {
    return results.map(result => new ExposureGroupTableItem({
      SampleDate: result.SampleDate,
      ExposureGroup: "",
      TWA: result.TWA,
      Notes: result.Notes,
      SampleNumber: result.SampleNumber
    }));
  }

  isExpanded(group: ExposureGroup): boolean {
    return this.expandedGroup === group;
  }

  toggle(group: ExposureGroup) {
    this.expandedGroup = this.isExpanded(group) ? null : group;
  }

  // Template helpers
  columnId(col: string | EzColumn): string {
    return typeof col === 'string' ? col : col.Name;
  }

  columnHeader(col: string | EzColumn): string {
    return typeof col === 'string' ? col : (col.DisplayName || col.Name);
  }
}
