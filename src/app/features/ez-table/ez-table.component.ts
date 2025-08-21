import { AfterViewInit, Component, computed, input, signal, ViewChild, WritableSignal, inject } from '@angular/core';
import { MatPaginator, MatPaginatorModule } from '@angular/material/paginator';
import { MatTable, MatTableDataSource, MatTableModule } from '@angular/material/table';
import { MatSort, MatSortModule, Sort } from '@angular/material/sort';
import { CommonModule } from '@angular/common';
import { ExposureGroup } from '../../models/exposure-group.model';
import { SampleInfo } from '../../models/sample-info.model';
import { ExposureGroupTableItem } from '../../models/exposure-group-table-item.model';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonModule } from '@angular/material/button';
import { EzColumn } from '../../models/ez-column.model';
import { EzFormatPipe } from '../../pipes/ez-format.pipe';
import { LiveAnnouncer } from '@angular/cdk/a11y';

@Component({
  selector: 'ez-table',
  imports: [
    CommonModule,
    MatTableModule,
    MatPaginatorModule,
    MatSortModule,
    MatIconModule,
    MatTooltipModule,
    MatButtonModule,
    EzFormatPipe,
  ],
  templateUrl: './ez-table.component.html',
  styleUrl: './ez-table.component.scss'
})
export class EzTableComponent implements AfterViewInit {
  private liveAnnouncer = inject(LiveAnnouncer);
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
  // Filtering support (by default, filters by ExposureGroup)
  filterText = input<string>('');
  filterKey = input<string>('ExposureGroup');
  // Default sort support
  defaultSortActive = input<string | null>(null);
  defaultSortDirection = input<'asc' | 'desc'>('asc');
  // Paginator config
  pageSize = input<number>(10);
  pageSizeOptions = input<number[]>([5, 10, 25, 50]);

  // Deprecated/back-compat inputs (will be removed when callers migrate)
  displayedColumns = input<(string | EzColumn)[]>(['SampleDate', 'ExposureGroup', 'TWA', 'Notes', 'SampleNumber']);
  data = input<ExposureGroup[]>([]);
  dataResults = input<SampleInfo[]>([]);
  detailSource = input<'group' | 'ef'>('group');

  private defaultSortApplied = false;
  paginatorSignal: WritableSignal<MatPaginator | null> = signal(null);
  sortSignal: WritableSignal<MatSort | null> = signal(null);
  @ViewChild(MatTable) private table?: MatTable<any>;

  // Use setters so we catch when the view branch with matSort/matPaginator appears later
  @ViewChild(MatPaginator)
  set paginator(p: MatPaginator) {
    if (p) {
      this.paginatorSignal.set(p);
      // Keep data sources wired up
      p.pageSize = this.pageSize();
      // Do not attach to both data sources here; we'll attach only the active one
      // inside the computed dataSource getters to avoid dual subscriptions.
    }
  }

  @ViewChild(MatSort)
  set sort(s: MatSort) {
    if (s) {
      this.sortSignal.set(s);
      // Do not wire both data sources here; attach only the active one
      // inside the computed getters to prevent conflicting subscriptions.
      // Apply default sort once when sort is first available
      this.applyDefaultSortIfNeeded();
    }
  }

  // Persistent data sources to keep MatSort bindings stable
  private groupDataSource = new MatTableDataSource<any>([]);
  private flatDataSource = new MatTableDataSource<ExposureGroupTableItem>([]);
  // Resolve string IDs for columns to satisfy MatTable APIs
  columnIds = computed(() => (this.displayedColumns() ?? []).map(c => typeof c === 'string' ? c : c.Name));
  summaryColumnIds = computed(() => (this.summaryColumns()?.length ? this.summaryColumns() : this.defaultSummaryColumns()).map(c => typeof c === 'string' ? c : c.Name));
  detailColumnIds = computed(() => (this.detailColumns()?.length ? this.detailColumns() : this.displayedColumns()).map(c => typeof c === 'string' ? c : c.Name));
  // DataSource for flat SampleInfo rows mode
  dataTableSource = computed(() => {
    let mappedData: ExposureGroupTableItem[] = [];
    if (this.data().length) {
      mappedData = this.mapExposureGroupsToTableItems(this.data());
    } else {
      mappedData = this.mapResultsToTableItems(this.dataResults() ?? []);
    }
    this.flatDataSource.data = mappedData;
    // Attach paginator only to the flat data source when flat table is active
    if (this.paginatorSignal()) {
      this.flatDataSource.paginator = this.paginatorSignal();
    }
    // Detach paginator from the group data source to avoid dual subscriptions
    this.groupDataSource.paginator = null as any;
    // Flat table does not use MatSort in the template, but keep accessor consistent if needed
    if (this.sortSignal()) {
      this.flatDataSource.sort = this.sortSignal()!;
      this.flatDataSource.sortingDataAccessor = (item: any, property: string): any => this.sortAccessor(item, property);
    }
    // Ensure group data source is not bound to sort when flat table is active
    this.groupDataSource.sort = null as any;
    return this.flatDataSource;
  });

  // DataSource for generic items (expandable)
  groupTableSource = computed(() => {
    // Read filter inputs to make this computed reactive to them
    const filter = (this.filterText() || '').trim().toLowerCase();
    const filterKey = this.filterKey();
    const groups = (this.items()?.length ? this.items() : (this.data() ?? []));
    this.groupDataSource.data = groups;
    // Attach paginator only to the group data source when group table is active
    if (this.paginatorSignal()) {
      this.groupDataSource.paginator = this.paginatorSignal();
    }
    // Detach paginator from the flat data source to avoid dual subscriptions
    this.flatDataSource.paginator = null as any;
    if (this.sortSignal()) {
      this.groupDataSource.sort = this.sortSignal()!;
      this.groupDataSource.sortingDataAccessor = (item: any, property: string): any => this.sortAccessor(item, property);
    }
    // Ensure flat data source is not bound to sort when group table is active
    this.flatDataSource.sort = null as any;
    // Filter by exposure group (or configured key)
    this.groupDataSource.filterPredicate = (item: any, filt: string): boolean => {
      if (!filt) return true;
      const val = (filterKey === 'ExposureGroup')
        ? (item?.ExposureGroup ?? item?.Group ?? '')
        : (item?.[filterKey] ?? '');
      return String(val).toLowerCase().includes(filt);
    };
    this.groupDataSource.filter = filter;
    // Ensure paginator resets on filter changes so page displays results
    if (this.groupDataSource.paginator) {
      try { this.groupDataSource.paginator.firstPage(); } catch { }
    }
    return this.groupDataSource;
  });

  // Columns for the group table (expand + configured summary columns)
  get groupColumns(): string[] {
    return ['expand', ...this.summaryColumnIds()];
  }

  // Optional: announce sort changes for accessibility
  announceSortChange(sortState: Sort) {
    if (sortState.direction) {
      this.liveAnnouncer.announce(`Sorted by ${sortState.active} ${sortState.direction}`);
    } else {
      this.liveAnnouncer.announce('Sorting cleared');
    }
  }

  // Track expansion by a stable key (Uid if provided, else group name)
  private expandedKey: string | null = null;

  ngAfterViewInit() {
    // Nothing needed here; we attach sort/paginator in the @ViewChild setters because
    // the table may render conditionally after init.
  }

  private applyDefaultSortIfNeeded() {
    if (this.defaultSortApplied) return;
    const s = this.sortSignal();
    const active = this.defaultSortActive();
    if (!s || !active) return;
    this.defaultSortApplied = true;
    setTimeout(() => {
      try {
        const sortable = (s as any).sortables?.get(active);
        if (sortable && typeof s.sort === 'function') {
          s.sort(sortable);
          s.direction = this.defaultSortDirection();
          s.sortChange.emit({ active: s.active, direction: s.direction });
        } else {
          (s as any).active = active;
          (s as any).direction = this.defaultSortDirection();
          s.sortChange.emit({ active: active, direction: this.defaultSortDirection() });
        }
      } catch { }
    });
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

  private groupKey(group: any): string {
    if (group?.Uid) return String(group.Uid);
    return (group?.ExposureGroup ?? group?.Group ?? '').toString();
  }

  isExpanded(group: any): boolean {
    if (!group) return false;
    return this.expandedKey === this.groupKey(group);
  }

  toggle(group: any) {
    const key = this.groupKey(group);
    this.expandedKey = (this.expandedKey === key) ? null : key;
    // Ensure table re-renders row defs (including the detail row) immediately
    try { this.table?.renderRows(); } catch { }
  }

  // Row predicate to render expanded detail rows only for expanded items
  rowIsExpanded = (_index: number, row: any) => this.expandedKey === this.groupKey(row);

  // Template helpers
  columnId(col: string | EzColumn): string {
    return typeof col === 'string' ? col : col.Name;
  }

  columnHeader(col: string | EzColumn): string {
    return typeof col === 'string' ? col : (col.DisplayName || col.Name);
  }

  // Format helpers used by the template
  isPercentBadge(col: string | EzColumn): boolean {
    return typeof col !== 'string' && (col?.Format === 'percent-badge');
  }

  isTrend(col: string | EzColumn): boolean {
    return typeof col !== 'string' && (col?.Format === 'trend');
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

  // Sorting helper for MatTableDataSource
  private sortAccessor(item: any, property: string): any {
    const normalizeDate = (v: any) => {
      const d = new Date(v);
      const t = d.getTime();
      return isNaN(t) ? 0 : t;
    };
    if (property === 'ExposureGroup') {
      return (item?.ExposureGroup ?? item?.Group ?? '').toString().toLowerCase();
    }
    if (property === 'Samples' || property === 'SamplesUsed') {
      return Number(item?.[property] ?? (item?.Results?.length ?? 0));
    }
    if (property === 'LatestEF') {
      const nested = item?.LatestExceedanceFraction?.ExceedanceFraction;
      return Number(nested ?? item?.LatestEF ?? 0);
    }
    if (property === 'ExceedanceFraction' || property === 'TWA') {
      return Number(item?.[property] ?? 0);
    }
    if (property === 'DateCalculated' || property === 'ExceedanceFractionDate' || property === 'SampleDate') {
      const val = item?.[property] ?? item?.LatestExceedanceFraction?.DateCalculated;
      return normalizeDate(val);
    }
    return item?.[property];
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
