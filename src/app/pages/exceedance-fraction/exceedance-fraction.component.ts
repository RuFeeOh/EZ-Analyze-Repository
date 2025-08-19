import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Firestore } from '@angular/fire/firestore';
import { collection, query, where } from 'firebase/firestore';
import { collectionData } from '@angular/fire/firestore';
import { OrganizationService } from '../../services/organization/organization.service';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { EzTableComponent } from '../../features/ez-table/ez-table.component';
import { SampleInfo } from '../../models/sample-info.model';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { EzColumn } from '../../models/ez-column.model';

@Component({
  selector: 'app-exceedance-fraction',
  imports: [CommonModule, MatTableModule, MatIconModule, MatButtonModule, EzTableComponent],
  templateUrl: './exceedance-fraction.component.html',
  styleUrl: './exceedance-fraction.component.scss'
})
export class ExceedanceFractionComponent {
  private firestore = inject(Firestore);
  private orgService = inject(OrganizationService);
  exposureGroups$!: Observable<any[]>;
  resultsData: SampleInfo[] = [];
  latestEfItems$!: Observable<any[]>;
  // Table configuration for ez-table (generic)
  readonly efSummaryColumns = [
    new EzColumn({ Name: 'ExposureGroup', DisplayName: 'Exposure Group' }),
    new EzColumn({ Name: 'LatestEF', DisplayName: 'Exceedance Fraction', Format: 'percent' }),
    new EzColumn({ Name: 'ExceedanceFractionDate', DisplayName: 'Exceedance Fraction Date', Format: 'date' })
  ];
  readonly efDetailColumns: string[] = ['SampleDate', 'ExposureGroup', 'TWA', 'Notes', 'SampleNumber'];
  readonly efDetailForItem = (item: any) => item?.ResultsUsed ?? [];

  constructor() {
    const ref = collection(this.firestore, 'exposureGroups');
    // Prefer filtering by current org to satisfy rules and reduce data
    const orgId = this.orgService.currentOrg?.Uid;
    const q = orgId ? query(ref, where('OrganizationUid', '==', orgId)) : ref;
    this.exposureGroups$ = collectionData(q as any, { idField: 'Uid' }).pipe(map(d => d as any[]));

    // Build latest EF items from each group's history
    this.latestEfItems$ = this.exposureGroups$.pipe(
      map(groups => (groups || []).map(g => {
        const history = (g?.ExceedanceFractionHistory || []) as any[];
        // pick the latest by DateCalculated; fallback to g.LatestExceedanceFraction
        let latest = history
          .slice()
          .sort((a, b) => new Date(b?.DateCalculated || 0).getTime() - new Date(a?.DateCalculated || 0).getTime())[0];
        if (!latest) {
          latest = g?.LatestExceedanceFraction;
        }
        return {
          ExposureGroup: g?.ExposureGroup ?? g?.Group ?? '',
          LatestEF: latest?.ExceedanceFraction ?? 0,
          ExceedanceFractionDate: latest?.DateCalculated ?? '',
          ResultsUsed: latest?.ResultsUsed ?? [],
        };
      }))
    );
  }

}
