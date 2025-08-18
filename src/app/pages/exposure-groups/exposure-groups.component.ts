import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Firestore } from '@angular/fire/firestore';
import { collection, query, where } from 'firebase/firestore';
import { collectionData } from '@angular/fire/firestore';
import { OrganizationService } from '../../services/organization/organization.service';
import { EzTableComponent } from '../../features/ez-table/ez-table.component';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Component({
    selector: 'app-exposure-groups',
    imports: [CommonModule, EzTableComponent],
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
        const ref = collection(this.firestore, 'exposureGroups');
        const orgId = this.orgService.currentOrg?.Uid;
        const q = orgId ? query(ref, where('OrganizationUid', '==', orgId)) : ref;
        this.exposureGroups$ = collectionData(q as any, { idField: 'Uid' }).pipe(map(d => d as any[]));
    }
}
