import { computed, inject, Injectable, OnInit, Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { collectionData } from '@angular/fire/firestore';
import { collection, addDoc, where, query, doc, deleteDoc } from 'firebase/firestore';
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

  constructor() {
    this.loadCurrentOrganizationFromLocalStorage();
  }

  private loadCurrentOrganizationFromLocalStorage() {
    const currentOrg = localStorage.getItem('currentOrg');
    if (currentOrg) {
      this.setCurrentOrg(JSON.parse(currentOrg));
    }
  }

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
    localStorage.setItem('currentOrg', JSON.stringify(org));
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
    // Once the save is succesful, set the current organization
    this.setCurrentOrg(orgToSave);
    return newMessageRef;
  }

  public async deleteOrganization(orgId: string) {
    if (!orgId) throw new Error('Organization id is required');
    const orgRef = doc(this.firestore as any, `organizations/${orgId}`);
    await deleteDoc(orgRef as any);
    if (this.currentOrg?.Uid === orgId) {
      this.currentOrg = null;
      localStorage.removeItem('currentOrg');
    }
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
