import { computed, inject, Injectable, Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { collectionData } from '@angular/fire/firestore';
import { collection, addDoc, where, query } from 'firebase/firestore';
import { catchError, map, Observable, of, switchMap } from 'rxjs';
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
  private user = toSignal(this.user$, { initialValue: null });
  private get userUid() {
    return this.auth.currentUser?.uid;
  }
  private organizationList$ = this.user$.pipe(
    switchMap(user => user ? this.getOrganizationList() : of([]))
  )
  organizationList: Signal<any[]> = toSignal(this.organizationList$, { initialValue: [] })

  private getOrganizationList(): Observable<Organization[]> {
    const organizationCollection = collection(this.firestore, 'organizations');
    const userOrganizations = query(organizationCollection, where('UserUids', 'array-contains', this.userUid));

    const organizations$ = collectionData(userOrganizations, { idField: 'Uid' });
    return organizations$.pipe(
      map((docs) => docs.map((doc) => doc as Organization)),
      catchError((error) => {
        console.error(error);
        return of([]);
      })
    );
  }

  setCurrentOrg(org: Organization) {
    this.currentOrg = org;
    console.log("setting org in service", org);
  }

  public async saveOrganization(organizationName: string) {
    const userId = this.userUid;
    if (!userId) throw new Error('User not authenticated');
    if (!organizationName) throw new Error('Organization name is required');

    const orgToSave = this.createNewOrgToSave(organizationName, userId);
    const newMessageRef = await addDoc(
      collection(this.firestore, "organizations"),
      this.plainObject(orgToSave)
    );
    return newMessageRef;
  }


  private createNewOrgToSave(organizationName: string, userId: string) {
    return new Organization({
      Name: organizationName,
      UserUids: [userId],
      Permissions: {
        [userId]: { assignPermissions: true }
      }
    });
  }


  private plainObject<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }
}
