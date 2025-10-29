import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Firestore } from '@angular/fire/firestore';
import { collection } from 'firebase/firestore';
import { collectionData } from '@angular/fire/firestore';
import { OrganizationService } from '../../services/organization/organization.service';
import { EzTableComponent } from '../../features/ez-table/ez-table.component';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Component({
    selector: 'app-exposure-groups',
    imports: [CommonModule, MatProgressSpinnerModule, MatIconModule, MatTooltipModule, EzTableComponent],
    templateUrl: './exposure-groups.component.html',
    styleUrl: './exposure-groups.component.scss'
})
export class ExposureGroupsComponent {
    private firestore = inject(Firestore);
    private orgService = inject(OrganizationService);
    exposureGroups$!: Observable<any[]>;
    // Accessor used by ez-table to get detail rows for a group
    readonly detailForFn = (group: any) => group?.Results ?? [];

    constructor() {
        const orgId = this.orgService.orgStore.currentOrg()?.Uid || 'unknown';
        const refShared = collection(this.firestore, `organizations/${orgId}/exposureGroups`);
        this.exposureGroups$ = collectionData(refShared as any, { idField: 'Uid' }).pipe(map(d => d as any[]));
    }
}
