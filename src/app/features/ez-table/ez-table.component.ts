import { AfterViewInit, Component, ContentChild, ElementRef, HostListener, TemplateRef, computed, input, signal, ViewChild, WritableSignal, inject } from '@angular/core';
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
import { MatMenuModule } from '@angular/material/menu';
import { EzColumn } from '../../models/ez-column.model';
import { LiveAnnouncer } from '@angular/cdk/a11y';

export type EzTableExportFormatter = (context: {
  value: any;
  row: any;
  column: string | EzColumn;
  columnId: string;
  section: 'summary' | 'detail';
}) => string | number | null | undefined;

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
    MatMenuModule,
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
  readonly summaryColumns = input<(string | EzColumn)[]>([]);
  readonly detailColumns = input<(string | EzColumn)[]>([]);
  readonly items = input<any[]>([]);
  readonly detailFor = input<(item: any) => any[] | undefined>();
  // Optional: custom row key accessor for expansion tracking and identity
  readonly keyFor = input<(item: any) => string | number | null | undefined>();
  // Filtering support (by default, filters by ExposureGroup)
  readonly filterText = input<string>('');
  readonly filterKey = input<string>('ExposureGroup');
  // Default sort support
  readonly defaultSortActive = input<string | null>(null);
  readonly defaultSortDirection = input<'asc' | 'desc'>('asc');
  // Paginator config
  readonly pageSize = input<number>(1000);
  readonly pageSizeOptions = input<number[]>([5, 10, 25, 50, 1000]);
  // Optional export-specific formatting overrides (per column id)
  readonly exportFormatters = input<Record<string, EzTableExportFormatter> | null>(null);

  // Deprecated/back-compat inputs (will be removed when callers migrate)
  readonly displayedColumns = input<(string | EzColumn)[]>(['SampleDate', 'ExposureGroup', 'TWA', 'Notes', 'SampleNumber']);
  readonly data = input<ExposureGroup[]>([]);
  readonly dataResults = input<SampleInfo[]>([]);
  readonly detailSource = input<'group' | 'ef' | null>(null);

  private defaultSortApplied = false;
  paginatorSignal: WritableSignal<MatPaginator | null> = signal(null);
  sortSignal: WritableSignal<MatSort | null> = signal(null);
  @ViewChild(MatTable) private table?: MatTable<any>;
  // Store viewport element and trigger resize when it becomes available
  private _viewportEl?: ElementRef<HTMLDivElement>;
  @ViewChild('viewport')
  set viewportEl(el: ElementRef<HTMLDivElement> | undefined) {
    this._viewportEl = el;
    // When the viewport appears (including after conditional renders), size it
    this.resizeViewport();
  }

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
  private percentFormatter = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
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
  protected hasDetail(): boolean {
    if (this.detailFor()) return true;
    const cols = this.detailColumns();
    if (cols && cols.length > 0) return true;
    return this.detailSource() != null;
  }

  get groupColumns(): string[] {
    const cols = [...this.summaryColumnIds()];
    const hasExpand = this.hasDetail();
    const selectIdx = cols.indexOf('Select');
    // If Select column exists, put it foremost on the left, then expand (if any), then the rest
    if (selectIdx > -1) {
      cols.splice(selectIdx, 1);
      return ['Select', ...(hasExpand ? ['expand'] : []), ...cols];
    }
    // Otherwise keep expand first (when present) followed by all columns
    return [...(hasExpand ? ['expand'] : []), ...cols];
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
    this.resizeViewport();
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

  // Dynamically size the viewport to fill remaining window space while respecting
  // min and max caps. Max around 70vh, min 300px.
  @HostListener('window:resize')
  protected resizeViewport() {
    const el = this._viewportEl?.nativeElement;
    if (!el) return;
    try {
      const rect = el.getBoundingClientRect();
      const windowH = window.innerHeight || document.documentElement.clientHeight;
      // Space available from top of viewport container to bottom of window
      const available = Math.max(0, windowH - rect.top - 16); // leave small bottom gap
      const maxCap = Math.round(windowH * 0.7);
      const target = Math.min(available, maxCap);
      const clamped = Math.max(300, target);
      el.style.maxHeight = clamped + 'px';
      el.style.overflow = 'auto';
    } catch { /* no-op */ }
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
    // Prefer a custom key accessor if provided
    const keyAccessor = this.keyFor();
    if (typeof keyAccessor === 'function') {
      try {
        const k = keyAccessor(group);
        if (k !== undefined && k !== null && k !== '') return String(k);
      } catch { /* ignore and fall back */ }
    }
    if (group?.Uid) return String(group.Uid);
    return (group?.ExposureGroup ?? group?.Group ?? '').toString();
  }

  protected isExpanded(group: any): boolean {
    if (!group) return false;
    return this.expandedKey === this.groupKey(group);
  }

  protected toggle(group: any) {
    const key = this.groupKey(group);
    this.expandedKey = (this.expandedKey === key) ? null : key;
    // Ensure table re-renders row defs (including the detail row) immediately
    try { this.table?.renderRows(); } catch { }
  }

  // Row predicate to render expanded detail rows only for expanded items
  protected rowIsExpanded = (_index: number, row: any) => this.expandedKey === this.groupKey(row);

  public exportVisibleRows() {
    const columns = this.getActiveColumns();
    const rows = this.getVisibleRows();
    if (!columns.length || !rows.length) {
      console.warn('EZ Table export skipped: no visible data.');
      return;
    }
    const csv = this.buildCsv(columns, rows);
    this.triggerCsvDownload(csv);
  }

  private triggerCsvDownload(csv: string) {
    if (!csv) return;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().split('T')[0];
    link.href = url;
    link.setAttribute('download', `ez-table-export-${timestamp}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  private buildCsv(columns: (string | EzColumn)[], rows: any[]): string {
    const header = columns.map(col => this.escapeCsv(this.columnHeader(col))).join(',');
    const body = rows.map(row => columns.map(col => this.escapeCsv(this.valueForExport(row, col, 'summary'))).join(','));
    return [header, ...body].join('\n');
  }

  private escapeCsv(value: any): string {
    const raw = value == null ? '' : String(value);
    const needsQuotes = /[",\n]/.test(raw);
    const escaped = raw.replace(/"/g, '""');
    return needsQuotes ? `"${escaped}"` : escaped;
  }

  private getActiveColumns(): (string | EzColumn)[] {
    if (this.isGroupModeActive()) {
      const cols = this.summaryColumns();
      if (cols?.length) return cols;
      return this.defaultSummaryColumns();
    }
    return this.displayedColumns() ?? [];
  }

  private getVisibleRows(): any[] {
    const dataSource = this.isGroupModeActive() ? this.groupTableSource() : this.dataTableSource();
    if (!dataSource) return [];
    const filtered = dataSource.filteredData?.slice() ?? dataSource.data?.slice() ?? [];
    const sorted = dataSource.sort ? dataSource.sortData(filtered, dataSource.sort) : filtered;
    const paginator = dataSource.paginator;
    if (paginator) {
      const start = paginator.pageIndex * paginator.pageSize;
      const end = start + paginator.pageSize;
      return sorted.slice(start, end);
    }
    return sorted;
  }

  private isGroupModeActive(): boolean {
    return (this.items()?.length ?? 0) > 0 || (this.data()?.length ?? 0) > 0;
  }

  // Template helpers
  protected columnId(col: string | EzColumn): string {
    return typeof col === 'string' ? col : col.Name;
  }

  protected columnHeader(col: string | EzColumn): string {
    return typeof col === 'string' ? col : (col.DisplayName || col.Name);
  }

  protected isSortable(col: string | EzColumn): boolean {
    // Do not allow sorting on the Select checkbox column
    const id = this.columnId(col);
    if (id === 'Select') return false;
    return typeof col === 'string' ? true : (col.Sortable !== false);
  }

  // Format helpers used by the template
  protected isPercentBadge(col: string | EzColumn): boolean {
    return typeof col !== 'string' && (col?.Format === 'percent-badge');
  }

  protected isTrend(col: string | EzColumn): boolean {
    return typeof col !== 'string' && (col?.Format === 'trend');
  }

  private valueForExport(item: any, col: string | EzColumn, section: 'summary' | 'detail'): any {
    const key = this.columnId(col);
    const baseValue = this.valueFor(item, col, section);
    const formatterMap = this.exportFormatters();
    const formatter = formatterMap?.[key];
    if (typeof formatter === 'function') {
      try {
        const formatted = formatter({ value: baseValue, row: item, column: col, columnId: key, section });
        if (formatted !== undefined && formatted !== null) {
          return formatted;
        }
      } catch (err) {
        console.warn('EZ Table export formatter failed for column', key, err);
      }
    }
    if (this.shouldFormatAsPercent(col)) {
      return this.formatPercent(baseValue);
    }
    return baseValue ?? '';
  }

  private shouldFormatAsPercent(col: string | EzColumn): boolean {
    return typeof col !== 'string' && (col?.Format === 'percent' || col?.Format === 'percent-badge');
  }

  private formatPercent(raw: any): string {
    if (raw === undefined || raw === null || raw === '') return '';
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return '';
      if (trimmed.endsWith('%')) return trimmed;
      const parsed = Number(trimmed);
      if (!isNaN(parsed)) {
        return this.percentFormatter.format(parsed > 1 ? parsed : parsed * 100) + '%';
      }
      return trimmed;
    }
    if (typeof raw === 'number' && isFinite(raw)) {
      const percentValue = raw > 1 ? raw : raw * 100;
      return this.percentFormatter.format(percentValue) + '%';
    }
    return '';
  }

  // Resolve values for summary/detail cells
  protected valueFor(item: any, col: string | EzColumn, section: 'summary' | 'detail'): any {
    const key = this.columnId(col);
    // Special handling for common group fields when using defaults
    if (key === 'ExposureGroup') {
      return item?.ExposureGroup ?? item?.Group ?? '';
    }
    if (key === 'Samples') {
      if (this.detailSource() === 'ef') {
        return item?.LatestExceedanceFraction?.ResultsUsed?.length ?? 0;
      }
      // Prefer total count if present, else preview length, else legacy Results length
      const total = item?.ResultsTotalCount;
      if (typeof total === 'number') return total;
      const previewLen = item?.ResultsPreview?.length;
      if (typeof previewLen === 'number') return previewLen;
      return item?.Results?.length ?? 0;
    }
    if (key === 'ResultsTotalCount') {
      const total = item?.ResultsTotalCount;
      if (typeof total === 'number') return total;
      // Fallbacks for older data
      const legacy = item?.Results?.length;
      if (typeof legacy === 'number') return legacy;
      const latestUsed = item?.LatestResultsUsed?.length ?? item?.LatestExceedanceFraction?.ResultsUsed?.length;
      return latestUsed ?? 0;
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
    // Reverse-sort mapping for Trend so that ascending puts "up" before "down"
    if (property === 'Trend') {
      const v = (item?.[property] ?? '').toString().toLowerCase();
      // up < flat < down in ascending order
      if (v === 'up') return -1;
      if (v === 'flat') return 0;
      if (v === 'down') return 1;
      return 0;
    }
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

  protected detailsForItem(item: any): any[] {
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
    return item?.ResultsPreview ?? item?.Results ?? [];
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

  // Content-projected templates for custom cells or detail rendering
  @ContentChild('cell', { read: TemplateRef }) cellTpl?: TemplateRef<any>;
  @ContentChild('detail', { read: TemplateRef }) detailTpl?: TemplateRef<any>;
  // Optional header cell template for summary columns
  @ContentChild('headerCell', { read: TemplateRef }) headerTpl?: TemplateRef<any>;
}
