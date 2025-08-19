import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Firestore } from '@angular/fire/firestore';
import { collection, query, where } from 'firebase/firestore';
import { collectionData } from '@angular/fire/firestore';
import { OrganizationService } from '../../services/organization/organization.service';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { EzTableComponent } from '../../features/ez-table/ez-table.component';
import { SampleInfo } from '../../models/sample-info.model';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { EzColumn } from '../../models/ez-column.model';

@Component({
  selector: 'app-exceedance-fraction',
  imports: [CommonModule, MatTableModule, MatIconModule, MatButtonModule, MatSlideToggleModule, EzTableComponent],
  templateUrl: './exceedance-fraction.component.html',
  styleUrl: './exceedance-fraction.component.scss'
})
export class ExceedanceFractionComponent {
  private firestore = inject(Firestore);
  private orgService = inject(OrganizationService);
  exposureGroups$!: Observable<any[]>;
  resultsData: SampleInfo[] = [];
  // Streams
  efItems$!: Observable<any[]>;        // full history
  latestEfItems$!: Observable<any[]>;  // one per group
  // Toggle (default ON)
  showLatest = signal(true);
  // Table configuration for ez-table (generic)
  readonly efSummaryColumns = [
    new EzColumn({ Name: 'ExposureGroup', DisplayName: 'Exposure Group' }),
    new EzColumn({ Name: 'ExceedanceFraction', DisplayName: 'Exceedance Fraction', Format: 'percent' }),
    new EzColumn({ Name: 'DateCalculated', DisplayName: 'Calculation Date', Format: 'date' }),
    new EzColumn({ Name: 'SamplesUsed', DisplayName: 'Samples Used' })
  ];
  readonly efDetailColumns: string[] = ['SampleDate', 'ExposureGroup', 'TWA', 'Notes', 'SampleNumber'];
  readonly efDetailForItem = (item: any) => item?.ResultsUsed ?? [];

  constructor() {
    const ref = collection(this.firestore, 'exposureGroups');
    // Prefer filtering by current org to satisfy rules and reduce data
    const orgId = this.orgService.currentOrg?.Uid;
    const q = orgId ? query(ref, where('OrganizationUid', '==', orgId)) : ref;
    this.exposureGroups$ = collectionData(q as any, { idField: 'Uid' }).pipe(map(d => d as any[]));

    // Build full history EF items (flattened) and sort desc by DateCalculated
    this.efItems$ = this.exposureGroups$.pipe(
      map(groups => (groups || []).flatMap(g => {
        const history = (g?.ExceedanceFractionHistory || []) as any[];
        return history.map(ef => ({
          ExposureGroup: g?.ExposureGroup ?? g?.Group ?? '',
          ExceedanceFraction: ef?.ExceedanceFraction ?? 0,
          DateCalculated: ef?.DateCalculated ?? '',
          SamplesUsed: (ef?.ResultsUsed ?? []).length,
          ResultsUsed: ef?.ResultsUsed ?? [],
        }));
      }).sort((a, b) => new Date(b?.DateCalculated || 0).getTime() - new Date(a?.DateCalculated || 0).getTime()))
    );

    // Build latest EF items from each group's history; same shape as full history
    this.latestEfItems$ = this.exposureGroups$.pipe(
      map(groups => (groups || []).map(g => {
        const history = (g?.ExceedanceFractionHistory || []) as any[];
        let latest = history
          .slice()
          .sort((a, b) => new Date(b?.DateCalculated || 0).getTime() - new Date(a?.DateCalculated || 0).getTime())[0];
        if (!latest) {
          latest = g?.LatestExceedanceFraction;
        }
        return {
          ExposureGroup: g?.ExposureGroup ?? g?.Group ?? '',
          ExceedanceFraction: latest?.ExceedanceFraction ?? 0,
          DateCalculated: latest?.DateCalculated ?? '',
          SamplesUsed: (latest?.ResultsUsed ?? []).length,
          ResultsUsed: latest?.ResultsUsed ?? [],
        };
      }).sort((a, b) => new Date(b?.DateCalculated || 0).getTime() - new Date(a?.DateCalculated || 0).getTime()))
    );
  }

}
