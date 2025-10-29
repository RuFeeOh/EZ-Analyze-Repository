import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { toObservable } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { Firestore } from '@angular/fire/firestore';
import { collection } from 'firebase/firestore';
import { collectionData } from '@angular/fire/firestore';
import { OrganizationService } from '../../services/organization/organization.service';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { EzTableComponent } from '../../features/ez-table/ez-table.component';
import { Observable, combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';
import { EzColumn } from '../../models/ez-column.model';

@Component({
  selector: 'app-scheduling-statistics',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatTableModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
    MatFormFieldModule,
    MatInputModule,
    EzTableComponent
  ],
  templateUrl: './scheduling-statistics.component.html',
  styleUrl: './scheduling-statistics.component.scss'
})
export class SchedulingStatisticsComponent {
  private firestore = inject(Firestore);
  private orgService = inject(OrganizationService);

  exposureGroups$!: Observable<any[]>;
  schedulingStatsItems$!: Observable<any[]>;
  filteredItems$!: Observable<any[]>;

  // Quick filter by Exposure Group
  filter = signal('');

  // Table configuration
  readonly schedulingStatsColumns = [
    new EzColumn({ Name: 'ExposureGroup', DisplayName: 'Exposure Group' }),
    new EzColumn({ Name: 'AIHARating', DisplayName: 'AIHA Rating' }),
    new EzColumn({ Name: 'ExceedanceFraction', DisplayName: 'Exceedance Fraction', Format: 'percent-badge' })
  ];

  readonly detailColumns: string[] = ['SampleDate', 'ExposureGroup', 'TWA', 'Notes', 'SampleNumber'];
  readonly detailForItem = (item: any) => item?.ResultsUsed ?? [];

  constructor() {
    const orgId = this.orgService.orgStore.currentOrg()?.Uid;
    const ref = orgId
      ? collection(this.firestore, `organizations/${orgId}/exposureGroups`)
      : collection(this.firestore, 'organizations/unknown/exposureGroups');

    this.exposureGroups$ = collectionData(ref as any, { idField: 'Uid' }).pipe(
      map(d => d as any[])
    );

    // Build scheduling statistics items from exposure groups
    this.schedulingStatsItems$ = this.exposureGroups$.pipe(
      map(groups => this.buildSchedulingStatsItems(groups))
    );

    // Apply filter
    this.filteredItems$ = combineLatest([
      this.schedulingStatsItems$,
      toObservable(this.filter)
    ]).pipe(
      map(([items, filterText]) => {
        if (!filterText || !filterText.trim()) {
          return items;
        }
        const filterLower = filterText.toLowerCase().trim();
        return items.filter(item => 
          String(item?.ExposureGroup ?? '').toLowerCase().includes(filterLower)
        );
      })
    );
  }

  private buildSchedulingStatsItems(groups: any[]): any[] {
    const items: any[] = [];

    for (const group of groups) {
      if (!group?.Agents || typeof group.Agents !== 'object') {
        continue;
      }

      for (const [agentKey, agentData] of Object.entries(group.Agents)) {
        const agent = agentData as any;
        if (!agent) continue;

        // Get the latest exceedance fraction snapshot
        const efSnapshot = agent.ExceedanceFraction;
        if (!efSnapshot) continue;

        const exceedanceFraction = typeof efSnapshot.ExceedanceFraction === 'number' 
          ? efSnapshot.ExceedanceFraction 
          : null;

        const resultsUsed = Array.isArray(efSnapshot.ResultsUsed) 
          ? efSnapshot.ResultsUsed 
          : [];

        const oel = typeof agent.OELNumber === 'number' ? agent.OELNumber : 0.05;

        // Calculate AIHA rating
        const aihaRating = this.calculateAIHARating(resultsUsed, oel);

        items.push({
          ExposureGroup: group.Name || '',
          Agent: agent.Name || agentKey,
          AgentKey: agentKey,
          AIHARating: aihaRating.rating,
          AIHARatingText: this.getAIHARatingText(aihaRating.rating),
          NinetyFifthPercentile: aihaRating.ninetyFifthPercentile,
          Ratio: aihaRating.ratio,
          ExceedanceFraction: exceedanceFraction,
          OELNumber: oel,
          ResultsUsed: resultsUsed,
          DocUid: group.Uid,
          Uid: `${group.Uid}_${agentKey}`
        });
      }
    }

    return items;
  }

  private calculateAIHARating(results: any[], oel: number): {
    rating: number;
    ninetyFifthPercentile: number;
    ratio: number;
  } {
    // Get the most recent 6 samples with valid TWA values
    const measurements = results
      .filter((r: any) => typeof r.TWA === 'number' && !isNaN(r.TWA) && r.TWA > 0)
      .slice(0, 6)
      .map((r: any) => r.TWA);

    if (measurements.length === 0) {
      return { rating: 0, ninetyFifthPercentile: 0, ratio: 0 };
    }

    // Calculate 95th percentile using lognormal distribution
    const logMeasurements = measurements.map((x: number) => Math.log(x));
    const mean = logMeasurements.reduce((sum: number, val: number) => sum + val, 0) / logMeasurements.length;
    const variance = logMeasurements.reduce((sum: number, val: number) => sum + Math.pow(val - mean, 2), 0) / 
      (logMeasurements.length - 1);
    const stdDev = Math.sqrt(variance);

    // 95th percentile z-score is 1.645
    const zScore95 = 1.645;
    const log95thPercentile = mean + (zScore95 * stdDev);
    const ninetyFifthPercentile = Math.exp(log95thPercentile);

    // Calculate ratio
    const ratio = oel > 0 ? ninetyFifthPercentile / oel : 0;

    // Determine AIHA category
    let rating: number;
    if (ratio < 0.10) {
      rating = 1;
    } else if (ratio < 0.50) {
      rating = 2;
    } else if (ratio < 1.00) {
      rating = 3;
    } else {
      rating = 4;
    }

    return { rating, ninetyFifthPercentile, ratio };
  }

  private getAIHARatingText(rating: number): string {
    switch (rating) {
      case 1:
        return '1 (<10%)';
      case 2:
        return '2 (10-50%)';
      case 3:
        return '3 (50-100%)';
      case 4:
        return '4 (>100%)';
      default:
        return 'N/A';
    }
  }

  clearFilter() {
    this.filter.set('');
  }
}
