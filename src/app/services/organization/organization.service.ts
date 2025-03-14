import { inject, Injectable } from '@angular/core';
import { collectionData } from '@angular/fire/firestore';
import { collection } from 'firebase/firestore';
import { Observable } from 'rxjs';
import { Firestore } from '@angular/fire/firestore'

@Injectable({
  providedIn: 'root'
})
export class OrganizationService {
  private firestore = inject(Firestore);
  currentOrg: any = null;
  getOrganization(): Observable<any> {
    const organizationCollection = collection(this.firestore, 'organizations');
    const organizations = collectionData(organizationCollection, { idField: 'id' });
    return organizations;
  }

  setCurrentOrg(org: any) {
    this.currentOrg = org;
    console.log("setting org in service", org);
  }

}
