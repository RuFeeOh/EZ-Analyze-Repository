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
  // Quick filter by Exposure Group
  filter = signal('');
  // Table configuration for ez-table (generic)
  readonly efSummaryColumns = [
    new EzColumn({ Name: 'ExposureGroup', DisplayName: 'Exposure Group' }),
    new EzColumn({ Name: 'ExceedanceFraction', DisplayName: 'Exceedance Fraction', Format: 'percent-badge' }),
    new EzColumn({ Name: 'Trend', DisplayName: 'Trend', Format: 'trend' }),
    new EzColumn({ Name: 'DateCalculated', DisplayName: 'Calculation Date', Format: 'date' }),
    new EzColumn({ Name: 'SamplesUsed', DisplayName: 'Samples Used' })
  ];
  readonly efDetailColumns: string[] = ['SampleDate', 'ExposureGroup', 'TWA', 'Notes', 'SampleNumber'];
  readonly efDetailForItem = (item: any) => item?.ResultsUsed ?? [];

  constructor() {
    const orgId = this.orgService.currentOrg?.Uid;
    const ref = orgId
      ? collection(this.firestore, `organizations/${orgId}/exposureGroups`)
      : collection(this.firestore, 'organizations/unknown/exposureGroups');
    this.exposureGroups$ = collectionData(ref as any, { idField: 'Uid' }).pipe(map(d => d as any[]));

    // Build full history EF items (flattened) and sort desc by DateCalculated
    this.efItems$ = this.exposureGroups$.pipe(
      map(groups => (groups || []).flatMap(g => {
        const name = g?.ExposureGroup ?? g?.Group ?? '';
        const history = (g?.ExceedanceFractionHistory || []) as any[];
        const historyAsc = history.slice().sort((a, b) => new Date(a?.DateCalculated || 0).getTime() - new Date(b?.DateCalculated || 0).getTime());
        return historyAsc.map((ef, idx) => ({
          Uid: `${name}__${ef?.DateCalculated || 'no-date'}__${idx}`,
          ExposureGroup: name,
          ExceedanceFraction: ef?.ExceedanceFraction ?? 0,
          DateCalculated: ef?.DateCalculated ?? '',
          SamplesUsed: (ef?.ResultsUsed ?? []).length,
          ResultsUsed: ef?.ResultsUsed ?? [],
          PrevExceedanceFraction: (idx > 0 ? historyAsc[idx - 1]?.ExceedanceFraction ?? null : null),
          PrevDateCalculated: (idx > 0 ? historyAsc[idx - 1]?.DateCalculated ?? '' : ''),
          Trend: (() => {
            if (idx === 0) return 'flat';
            const prev = historyAsc[idx - 1]?.ExceedanceFraction ?? null;
            const curr = ef?.ExceedanceFraction ?? null;
            if (prev == null || curr == null) return 'flat';
            if (curr > prev) return 'up';
            if (curr < prev) return 'down';
            return 'flat';
          })(),
          Delta: (() => {
            if (idx === 0) return 0;
            const prev = historyAsc[idx - 1]?.ExceedanceFraction ?? null;
            const curr = ef?.ExceedanceFraction ?? null;
            if (prev == null || curr == null) return 0;
            return (curr - prev);
          })(),
        }));
      }).sort((a, b) => new Date(b?.DateCalculated || 0).getTime() - new Date(a?.DateCalculated || 0).getTime()))
    );

    // Build latest EF items from each group's history; same shape as full history
    this.latestEfItems$ = this.exposureGroups$.pipe(
      map(groups => (groups || []).map(g => {
        const name = g?.ExposureGroup ?? g?.Group ?? '';
        const history = (g?.ExceedanceFractionHistory || []) as any[];
        let latest = history
          .slice()
          .sort((a, b) => new Date(b?.DateCalculated || 0).getTime() - new Date(a?.DateCalculated || 0).getTime())[0];
        if (!latest) {
          latest = g?.LatestExceedanceFraction;
        }
        // Determine trend against immediate previous when available
        let trend: 'up' | 'down' | 'flat' = 'flat';
        let delta = 0;
        if (history?.length >= 2) {
          const sorted = history.slice().sort((a, b) => new Date(b?.DateCalculated || 0).getTime() - new Date(a?.DateCalculated || 0).getTime());
          const curr = sorted[0]?.ExceedanceFraction ?? null;
          const prev = sorted[1]?.ExceedanceFraction ?? null;
          if (curr != null && prev != null) {
            if (curr > prev) trend = 'up';
            else if (curr < prev) trend = 'down';
            delta = (curr - prev);
          }
        }
        return {
          Uid: `${name}__latest__${latest?.DateCalculated || 'no-date'}`,
          ExposureGroup: name,
          ExceedanceFraction: latest?.ExceedanceFraction ?? 0,
          DateCalculated: latest?.DateCalculated ?? '',
          SamplesUsed: (latest?.ResultsUsed ?? []).length,
          ResultsUsed: latest?.ResultsUsed ?? [],
          Trend: trend,
          Delta: delta,
          PrevExceedanceFraction: (history?.length >= 2 ? (history.slice().sort((a, b) => new Date(b?.DateCalculated || 0).getTime() - new Date(a?.DateCalculated || 0).getTime())[1]?.ExceedanceFraction ?? null) : null),
          PrevDateCalculated: (history?.length >= 2 ? (history.slice().sort((a, b) => new Date(b?.DateCalculated || 0).getTime() - new Date(a?.DateCalculated || 0).getTime())[1]?.DateCalculated ?? '') : ''),
        };
      }).sort((a, b) => new Date(b?.DateCalculated || 0).getTime() - new Date(a?.DateCalculated || 0).getTime()))
    );
  }

}
