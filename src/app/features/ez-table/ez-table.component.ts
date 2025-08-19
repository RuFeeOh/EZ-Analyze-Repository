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
import { EzFormatPipe } from '../../pipes/ez-format.pipe';

@Component({
  selector: 'ez-table',
  imports: [
    CommonModule,
    MatTableModule,
    MatPaginatorModule,
    MatIconModule,
    MatButtonModule,
    EzFormatPipe,
  ],
  templateUrl: './ez-table.component.html',
  styleUrl: './ez-table.component.scss'
})
export class EzTableComponent implements AfterViewInit {
  // Generic configuration
  // - summaryColumns: rendered for the top-level rows (items)
  // - detailColumns: rendered for the expanded detail rows (detail items)
  // - items: the top-level rows (array of any)
  // - detailFor: function to get detail items for an item
  // Back-compat: if items not provided, it can derive a flat table from dataResults; if items provided, old data input is ignored.
  summaryColumns = input<(string | EzColumn)[]>([]);
  detailColumns = input<(string | EzColumn)[]>([]);
  items = input<any[]>([]);
  detailFor = input<(item: any) => any[] | undefined>();

  // Deprecated/back-compat inputs (will be removed when callers migrate)
  displayedColumns = input<(string | EzColumn)[]>(['SampleDate', 'ExposureGroup', 'TWA', 'Notes', 'SampleNumber']);
  data = input<ExposureGroup[]>([]);
  dataResults = input<SampleInfo[]>([]);
  detailSource = input<'group' | 'ef'>('group');

  @ViewChild(MatPaginator) paginator!: MatPaginator;
  paginatorSignal: WritableSignal<MatPaginator | null> = signal(null);
  // Resolve string IDs for columns to satisfy MatTable APIs
  columnIds = computed(() => (this.displayedColumns() ?? []).map(c => typeof c === 'string' ? c : c.Name));
  summaryColumnIds = computed(() => (this.summaryColumns()?.length ? this.summaryColumns() : this.defaultSummaryColumns()).map(c => typeof c === 'string' ? c : c.Name));
  detailColumnIds = computed(() => (this.detailColumns()?.length ? this.detailColumns() : this.displayedColumns()).map(c => typeof c === 'string' ? c : c.Name));
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

  // DataSource for generic items (expandable)
  groupTableSource = computed(() => {
    const groups = (this.items()?.length ? this.items() : (this.data() ?? []));
    const dataSource = new MatTableDataSource<any>(groups);
    if (this.paginatorSignal()) {
      dataSource.paginator = this.paginatorSignal();
    }
    return dataSource;
  });

  // Columns for the group table (expand + configured summary columns)
  get groupColumns(): string[] {
    return ['expand', ...this.summaryColumnIds()];
  }

  expandedGroup: any | null = null;

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

  // Resolve values for summary/detail cells
  valueFor(item: any, col: string | EzColumn, section: 'summary' | 'detail'): any {
    const key = this.columnId(col);
    // Special handling for common group fields when using defaults
    if (key === 'ExposureGroup') {
      return item?.ExposureGroup ?? item?.Group ?? '';
    }
    if (key === 'Samples') {
      if (this.detailSource() === 'ef') {
        return item?.LatestExceedanceFraction?.ResultsUsed?.length ?? 0;
      }
      return item?.Results?.length ?? 0;
    }
    if (key === 'LatestEF') {
      const nested = item?.LatestExceedanceFraction?.ExceedanceFraction;
      return nested ?? item?.LatestEF ?? 0;
    }
    if (key === 'ExceedanceFractionDate') {
      const nested = item?.LatestExceedanceFraction?.DateCalculated;
      return nested ?? item?.ExceedanceFractionDate ?? '';
    }
    if (key === 'Latest') {
      // Always the latest entry in this view; show a simple marker
      return 'Yes';
    }
    // Default: property lookup
    return item?.[key];
  }

  // Formatting is handled by ezFormat pipe in the template.

  detailsForItem(item: any): any[] {
    const accessor = this.detailFor();
    if (accessor) {
      try {
        return accessor(item) ?? [];
      } catch {
        return [];
      }
    }
    if (this.detailSource() === 'ef') {
      return item?.LatestExceedanceFraction?.ResultsUsed ?? [];
    }
    return item?.Results ?? [];
  }

  public defaultSummaryColumns(): (string | EzColumn)[] {
    // Fallback to sensible defaults when not provided
    if (this.data()?.length && this.detailSource() === 'ef') {
      // Exposure group + samples used + Latest EF
      return [
        new EzColumn({ Name: 'ExposureGroup', DisplayName: 'Exposure Group' }),
        new EzColumn({ Name: 'Samples', DisplayName: 'Samples Used' }),
        new EzColumn({ Name: 'LatestEF', DisplayName: 'Latest EF', Format: 'percent' })
      ];
    }
    if (this.data()?.length) {
      // Exposure groups view
      return [
        new EzColumn({ Name: 'ExposureGroup', DisplayName: 'Exposure Group' }),
        new EzColumn({ Name: 'Samples', DisplayName: 'Samples' })
      ];
    }
    // Flat table has no summary concept
    return [];
  }
}
