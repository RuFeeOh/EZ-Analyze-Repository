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
  // Table configuration for ez-table (generic)
  readonly efSummaryColumns = [
    new EzColumn({ Name: 'ExposureGroup', DisplayName: 'Exposure Group' }),
    new EzColumn({ Name: 'Samples', DisplayName: 'Samples Used' }),
    new EzColumn({ Name: 'LatestEF', DisplayName: 'Latest EF', Format: 'percent' })
  ];
  readonly efDetailColumns: string[] = ['SampleDate', 'ExposureGroup', 'TWA', 'Notes', 'SampleNumber'];
  readonly efDetailFor = (group: any) => group?.LatestExceedanceFraction?.ResultsUsed ?? [];

  constructor() {
    const ref = collection(this.firestore, 'exposureGroups');
    // Prefer filtering by current org to satisfy rules and reduce data
    const orgId = this.orgService.currentOrg?.Uid;
    const q = orgId ? query(ref, where('OrganizationUid', '==', orgId)) : ref;
    this.exposureGroups$ = collectionData(q as any, { idField: 'Uid' }).pipe(map(d => d as any[]));

    // For EF view, we don't need to flatten; ez-table uses groups and EF ResultsUsed for details.
  }

}
