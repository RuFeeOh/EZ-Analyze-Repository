import { AfterViewInit, Component, computed, input, signal, ViewChild, WritableSignal } from '@angular/core';
import { MatPaginator, MatPaginatorModule } from '@angular/material/paginator';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { CommonModule } from '@angular/common';
import { ExposureGroup } from '../../models/exposure-group.model';
import { SampleInfo } from '../../models/sample-info.model';
import { ExposureGroupTableItem } from '../../models/exposure-group-table-item.model';

@Component({
  selector: 'ez-table',
  imports: [
    CommonModule,
    MatTableModule,
    MatPaginatorModule,
  ],
  templateUrl: './ez-table.component.html',
  styleUrl: './ez-table.component.scss'
})
export class EzTableComponent implements AfterViewInit {
  displayedColumns = input<string[]>(['SampleDate', 'ExposureGroup', 'TWA', 'Notes', 'SampleNumber'])
  data = input<ExposureGroup[]>([]);
  dataResults = input<SampleInfo[]>([]);

  @ViewChild(MatPaginator) paginator!: MatPaginator;
  paginatorSignal: WritableSignal<MatPaginator | null> = signal(null);
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
}
