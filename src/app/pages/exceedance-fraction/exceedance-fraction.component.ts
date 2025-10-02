import { Component, ElementRef, HostListener, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { toObservable } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { Firestore } from '@angular/fire/firestore';
import { collection, query, where } from 'firebase/firestore';
import { collectionData } from '@angular/fire/firestore';
import { OrganizationService } from '../../services/organization/organization.service';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSliderModule } from '@angular/material/slider';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { EzTableComponent } from '../../features/ez-table/ez-table.component';
import { SampleInfo } from '../../models/sample-info.model';
import { Observable, combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';
import { buildHistoryEfItems, buildLatestEfItems } from '../../utils/ef-items.util';
import { EzColumn } from '../../models/ez-column.model';

@Component({
  selector: 'app-exceedance-fraction',
  imports: [CommonModule, FormsModule, MatTableModule, MatIconModule, MatButtonModule, MatSlideToggleModule, MatTooltipModule, MatSliderModule, MatProgressSpinnerModule, EzTableComponent],
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
  filteredEfItems$!: Observable<any[]>;
  filteredLatestEfItems$!: Observable<any[]>;
  // Toggle (default ON)
  showLatest = signal(true);
  // Quick filter by Exposure Group
  filter = signal('');
  // Legend bucket filter: '', 'good' (<5%), 'warn' (5-20%), 'bad' (>=20%), 'custom' (>= customThreshold)
  bucket = signal<'' | 'good' | 'warn' | 'bad' | 'custom'>('');
  // Custom threshold (fraction). Default 0.25 (25%). Editable via legend chip.
  customThreshold = signal(0.25);
  editingCustom = signal(false);
  @ViewChild('customThresholdWrapper') customWrapperRef?: ElementRef<HTMLElement>;
  private bucketFor(val: number | null | undefined): 'good' | 'warn' | 'bad' {
    const v = typeof val === 'number' ? val : 0;
    if (v < 0.05) return 'good';
    if (v < 0.20) return 'warn';
    return 'bad';
  }
  // Table configuration for ez-table (generic)
  readonly efSummaryColumns = [
    new EzColumn({ Name: 'ExposureGroup', DisplayName: 'Exposure Group' }),
    new EzColumn({ Name: 'ExceedanceFraction', DisplayName: 'Exceedance Fraction', Format: 'percent-badge' }),
    new EzColumn({ Name: 'Trend', DisplayName: 'Trend', Format: 'trend' }),
    new EzColumn({ Name: 'Agent', DisplayName: 'Agent' }),
    new EzColumn({ Name: 'OELNumber', DisplayName: 'OEL' }),
    new EzColumn({ Name: 'DateCalculated', DisplayName: 'Calculation Date', Format: 'date' }),
    new EzColumn({ Name: 'SamplesUsed', DisplayName: 'Samples Used' })
  ];
  readonly efDetailColumns: string[] = ['SampleDate', 'ExposureGroup', 'TWA', 'Notes', 'SampleNumber'];
  readonly efDetailForItem = (item: any) => item?.ResultsUsed ?? [];

  constructor() {
    const orgId = this.orgService.orgStore.currentOrg()?.Uid;
    const ref = orgId
      ? collection(this.firestore, `organizations/${orgId}/exposureGroups`)
      : collection(this.firestore, 'organizations/unknown/exposureGroups');
    this.exposureGroups$ = collectionData(ref as any, { idField: 'Uid' }).pipe(map(d => d as any[]));

    // Use pure utility functions (with internal memoization) to build items
    this.efItems$ = this.exposureGroups$.pipe(map(groups => buildHistoryEfItems(groups as any)));
    this.latestEfItems$ = this.exposureGroups$.pipe(map(groups => buildLatestEfItems(groups as any)));
    // Wire filtered streams to react to both data and bucket changes
    const bucket$ = toObservable(this.bucket);
    this.filteredEfItems$ = combineLatest([this.efItems$, bucket$, toObservable(this.customThreshold)]).pipe(
      map(([items, b, custom]) => {
        if (!b) return items;
        if (b === 'custom') return items.filter(i => (i?.ExceedanceFraction ?? 0) >= custom);
        return items.filter(i => i?.EfBucket === b);
      })
    );
    this.filteredLatestEfItems$ = combineLatest([this.latestEfItems$, bucket$, toObservable(this.customThreshold)]).pipe(
      map(([items, b, custom]) => {
        if (!b) return items;
        if (b === 'custom') return items.filter(i => (i?.ExceedanceFraction ?? 0) >= custom);
        return items.filter(i => i?.EfBucket === b);
      })
    );
  }

  beginEditCustom(event: Event) {
    event.stopPropagation();
    if (this.editingCustom()) {
      // Toggle off
      this.editingCustom.set(false);
      return;
    }
    this.editingCustom.set(true);
    this.bucket.set('custom');
  }

  toggleEditCustom(event: Event) { this.beginEditCustom(event); }

  private parseAndSetCustom(v: number) {
    if (!isNaN(v)) {
      if (v > 1) v = v / 100; // treat whole number as percent
      v = Math.min(Math.max(v, 0), 1);
      this.customThreshold.set(v);
      // Keep custom bucket selected
      if (this.bucket() !== 'custom') this.bucket.set('custom');
    }
  }

  commitCustomThreshold(raw: any) {
    let v = parseFloat(String(raw).trim());
    this.parseAndSetCustom(v);
    this.editingCustom.set(false);
  }

  updateCustomFromSlider(val: number) {
    this.parseAndSetCustom(val / 100);
  }

  updateCustomFromInput(raw: any) {
    let v = parseFloat(String(raw).trim());
    this.parseAndSetCustom(v);
  }

  toggleCustomBucket() {
    this.bucket.set(this.bucket() === 'custom' ? '' : 'custom');
  }

  // Close editor when clicking outside
  @HostListener('document:click', ['$event']) onDocumentClick(ev: MouseEvent) {
    if (!this.editingCustom()) return;
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    // If click is inside the wrapper, ignore
    if (this.customWrapperRef?.nativeElement.contains(target)) return;
    this.editingCustom.set(false);
  }

  // Close on Escape
  @HostListener('document:keydown.escape') onEscape() {
    if (this.editingCustom()) this.editingCustom.set(false);
  }

}
