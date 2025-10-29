import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { toObservable } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { Firestore } from '@angular/fire/firestore';
import { collection } from 'firebase/firestore';
import { collectionData } from '@angular/fire/firestore';
import { Functions, httpsCallable } from '@angular/fire/functions';
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
  private fns = inject(Functions);
  private orgService = inject(OrganizationService);

  exposureGroups$!: Observable<any[]>;
  schedulingStatsItems$!: Observable<any[]>;
  filteredItems$!: Observable<any[]>;

  // Quick filter by Exposure Group
  filter = signal('');
  
  // Recalculation state
  recalculating = signal(false);

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
      const name = group?.ExposureGroup || group?.Group || group?.Name || '';
      if (!name) continue;

      const docUid = group?.Uid;

      // Check for multi-agent structure (LatestExceedanceFractionByAgent)
      const latestByAgent = group?.LatestExceedanceFractionByAgent;
      
      if (latestByAgent && typeof latestByAgent === 'object' && Object.keys(latestByAgent).length > 0) {
        // Multi-agent structure
        for (const [agentKey, snapshot] of Object.entries(latestByAgent)) {
          if (!snapshot || typeof snapshot !== 'object') continue;

          const exceedanceFraction = typeof (snapshot as any).ExceedanceFraction === 'number' 
            ? (snapshot as any).ExceedanceFraction 
            : null;

          const resultsUsed = Array.isArray((snapshot as any).ResultsUsed) 
            ? (snapshot as any).ResultsUsed 
            : [];

          const oel = typeof (snapshot as any).OELNumber === 'number' 
            ? (snapshot as any).OELNumber 
            : 0.05;

          const agentName = (snapshot as any).AgentName || agentKey;

          // Calculate AIHA rating from the most recent 6 samples
          const aihaRating = this.calculateAIHARating(resultsUsed, oel);

          // Sort and limit results for display
          const sortedResults = this.sortAndLimitResults(resultsUsed);

          items.push({
            ExposureGroup: name,
            Agent: agentName,
            AgentKey: agentKey,
            AIHARating: aihaRating.rating,
            AIHARatingText: this.getAIHARatingText(aihaRating.rating),
            NinetyFifthPercentile: aihaRating.ninetyFifthPercentile,
            Ratio: aihaRating.ratio,
            ExceedanceFraction: exceedanceFraction,
            OELNumber: oel,
            ResultsUsed: sortedResults, // Show only the 6 samples used for calculation
            DocUid: docUid,
            Uid: `${docUid}_${agentKey}`
          });
        }
      } else {
        // Legacy single-agent structure
        const latest = group?.LatestExceedanceFraction;
        if (!latest) continue;

        const exceedanceFraction = typeof latest.ExceedanceFraction === 'number' 
          ? latest.ExceedanceFraction 
          : null;

        const resultsUsed = Array.isArray(latest.ResultsUsed) 
          ? latest.ResultsUsed 
          : [];

        const oel = typeof latest.OELNumber === 'number' ? latest.OELNumber : 0.05;

        const agentName = this.getAgentNameFromResults(resultsUsed);

        // Calculate AIHA rating from the most recent 6 samples
        const aihaRating = this.calculateAIHARating(resultsUsed, oel);

        // Sort and limit results for display
        const sortedResults = this.sortAndLimitResults(resultsUsed);

        items.push({
          ExposureGroup: name,
          Agent: agentName,
          AgentKey: this.slugifyAgent(agentName),
          AIHARating: aihaRating.rating,
          AIHARatingText: this.getAIHARatingText(aihaRating.rating),
          NinetyFifthPercentile: aihaRating.ninetyFifthPercentile,
          Ratio: aihaRating.ratio,
          ExceedanceFraction: exceedanceFraction,
          OELNumber: oel,
          ResultsUsed: sortedResults, // Show only the 6 samples used for calculation
          DocUid: docUid,
          Uid: `${docUid}_latest`
        });
      }
    }

    return items;
  }

  private sortAndLimitResults(results: any[]): any[] {
    return [...results].sort((a: any, b: any) => {
      const dateA = a.SampleDate ? new Date(a.SampleDate).getTime() : 0;
      const dateB = b.SampleDate ? new Date(b.SampleDate).getTime() : 0;
      return dateB - dateA; // descending order (most recent first)
    }).slice(0, 6);
  }

  private getAgentNameFromResults(results: any[]): string {
    if (!Array.isArray(results) || results.length === 0) return '';
    const found = results.find((r: any) => !!(r?.AgentName || r?.Agent));
    return found?.AgentName ?? found?.Agent ?? '';
  }

  private slugifyAgent(value: string): string {
    return (value || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 120) || 'unknown';
  }

  private calculateAIHARating(results: any[], oel: number): {
    rating: number;
    ninetyFifthPercentile: number;
    ratio: number;
  } {
    // Sort results by date (most recent first) and get the most recent 6 samples with valid TWA values
    const sortedResults = [...results].sort((a: any, b: any) => {
      const dateA = a.SampleDate ? new Date(a.SampleDate).getTime() : 0;
      const dateB = b.SampleDate ? new Date(b.SampleDate).getTime() : 0;
      return dateB - dateA; // descending order (most recent first)
    });

    const measurements = sortedResults
      .filter((r: any) => typeof r.TWA === 'number' && !isNaN(r.TWA) && r.TWA > 0)
      .slice(0, 6)
      .map((r: any) => r.TWA);

    if (measurements.length === 0) {
      return { rating: 0, ninetyFifthPercentile: 0, ratio: 0 };
    }

    // If only one measurement, use it as the 95th percentile
    if (measurements.length === 1) {
      const ninetyFifthPercentile = measurements[0];
      const ratio = oel > 0 ? ninetyFifthPercentile / oel : 0;
      const rating = this.getRatingFromRatio(ratio);
      return { rating, ninetyFifthPercentile, ratio };
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
    const rating = this.getRatingFromRatio(ratio);

    return { rating, ninetyFifthPercentile, ratio };
  }

  private getRatingFromRatio(ratio: number): number {
    if (ratio < 0.10) {
      return 1;
    } else if (ratio < 0.50) {
      return 2;
    } else if (ratio < 1.00) {
      return 3;
    } else {
      return 4;
    }
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

  async recalculateAIHARatings() {
    const orgId = this.orgService.orgStore.currentOrg()?.Uid;
    if (!orgId) {
      alert('No organization selected');
      return;
    }

    const confirmMessage = 'This will recalculate AIHA ratings for all exposure groups in this organization. Continue?';
    if (!window.confirm(confirmMessage)) {
      return;
    }

    try {
      this.recalculating.set(true);
      const callable = httpsCallable<{ orgId: string; groupIds?: string[] }, any>(
        this.fns,
        'addAIHARatingsRetroactively'
      );
      
      const result = await callable({ orgId });
      
      if (result.data?.ok) {
        alert(`Successfully recalculated AIHA ratings for ${result.data.processedCount} exposure group(s).`);
      } else {
        const errorMsg = result.data?.errors?.length 
          ? `Completed with ${result.data.errorCount} error(s). First error: ${result.data.errors[0]}`
          : 'Recalculation completed with some errors.';
        alert(errorMsg);
      }
    } catch (e: any) {
      console.error('Failed to recalculate AIHA ratings', e);
      alert(`Failed to recalculate AIHA ratings: ${e?.message || 'Unknown error'}`);
    } finally {
      this.recalculating.set(false);
    }
  }
}
