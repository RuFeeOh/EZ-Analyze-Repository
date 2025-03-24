import { computed, inject, Injectable, Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { collectionData } from '@angular/fire/firestore';
import { collection } from 'firebase/firestore';
import { Observable, of, switchMap } from 'rxjs';
import { Firestore } from '@angular/fire/firestore'
import { Auth, user } from '@angular/fire/auth';
import { Organization } from '../../models/organization.model';

@Injectable({
  providedIn: 'root'
})
export class OrganizationService {
  private firestore = inject(Firestore);
  private auth = inject(Auth);
  currentOrg: Organization | null = null;
  user$ = user(this.auth);
  private organizationList$ = this.user$.pipe(
    switchMap(user => user ? this.getOrganization() : of([]))
  )
  organizationList: Signal<any[]> = toSignal(this.organizationList$, { initialValue: [] })

  private getOrganization(): Observable<any[]> {
    const organizationCollection = collection(this.firestore, 'organizations');
    const organizations = collectionData(organizationCollection, { idField: 'id' });
    return organizations;
  }

  setCurrentOrg(org: Organization) {
    this.currentOrg = org;
    console.log("setting org in service", org);
  }

}
