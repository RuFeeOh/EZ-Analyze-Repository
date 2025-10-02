import { computed, inject, Injectable, OnInit, Signal, EnvironmentInjector, runInInjectionContext, WritableSignal, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { collectionData } from '@angular/fire/firestore';
import { collection, where, query, doc, setDoc } from 'firebase/firestore';
import { catchError, map, Observable, of, switchMap, defer } from 'rxjs';
import { Firestore } from '@angular/fire/firestore'
import { Auth, user } from '@angular/fire/auth';
import { httpsCallable } from '@angular/fire/functions';
import { Functions } from '@angular/fire/functions';
import { Organization } from '../../models/organization.model';
import { OrganizationStore } from './organization.store';
import { createInjectionContext } from '../../utils/create-injection-context.decorator';

@Injectable({
  providedIn: 'root'
})
export class OrganizationService {
  private firestore = inject(Firestore);
  private auth = inject(Auth);
  private env = inject(EnvironmentInjector);
  private fns = inject(Functions);
  public orgStore = inject(OrganizationStore);
  storedOrg: WritableSignal<Organization | null> = signal(null);
  user$ = user(this.auth);
  private user = toSignal(this.user$, { initialValue: null });
  private get userUid() {
    return this.auth.currentUser?.uid;
  }
  private organizationList$ = this.user$.pipe(
    switchMap(user => user ? this.getOrganizationList(user.uid ?? '') : of([]))
  )
  organizationList: Signal<any[]> = toSignal(this.organizationList$, { initialValue: [] })


  currentOrg: Signal<Organization | null> = computed(() => {
    // check if storedOrg is in the organizationList
    const orgList = this.organizationList();
    const stored = this.storedOrg();
    if (stored && orgList.some(o => o.Uid === stored.Uid)) {
      return stored;
    }
    // if not, return the first org in the list or null
    return orgList.length > 0 ? orgList[0] : null;
  });

  constructor() {
    this.loadCurrentOrganizationFromLocalStorage();
  }

  private loadCurrentOrganizationFromLocalStorage() {
    const currentOrg = localStorage.getItem('currentOrg');
    if (currentOrg) {
      this.setCurrentOrg(JSON.parse(currentOrg));
    }
  }

  private getOrganizationList(uid: string): Observable<Organization[]> {
    const organizationCollection = collection(this.firestore, 'organizations');
    const userOrganizations = query(organizationCollection, where('UserUids', 'array-contains', uid));

    const organizations$ = defer(() =>
      runInInjectionContext(this.env, () => collectionData(userOrganizations as any, { idField: 'Uid' }))
    );

    return organizations$.pipe(
      map((docs) => docs.map((doc) => doc as Organization)),
      catchError((error) => {
        console.error(error);
        return of([]);
      })
    );
  }

  setCurrentOrg(org: Organization) {
    this.orgStore.setCurrentOrg(org);
    localStorage.setItem('currentOrg', JSON.stringify(org));
  }

  clearCurrentOrg() {
    this.orgStore.clearCurrentOrg();
    localStorage.removeItem('currentOrg');
  }

  public async saveOrganization(organizationName: string) {
    const userId = this.userUid;
    if (!userId) throw new Error('User not authenticated');
    if (!organizationName) throw new Error('Organization name is required');

    const result = await this.addOrganization(organizationName);
    const orgWithUid = new Organization({ Name: result.data.name, Uid: result.data.orgId, UserUids: [userId], Permissions: { [userId]: { assignPermissions: true } } });
    this.setCurrentOrg(orgWithUid);
    return result.data;
  }

  @createInjectionContext()
  private async addOrganization(orgName: string) {

    const callable = httpsCallable<{ name: string }, { orgId: string; name: string }>(this.fns, 'createOrganization');
    const result = await callable({ name: orgName });
    return result;
  }

  public async deleteOrganization(orgId: string) {
    if (!orgId) throw new Error('Organization id is required');
    const callable = httpsCallable<{ orgId: string }, { deleted: boolean; orgId: string }>(this.fns, 'deleteOrganization');
    await callable({ orgId });
    if (this.orgStore.currentOrg()?.Uid === orgId) {
      this.orgStore.clearCurrentOrg();
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

  private async persistSelectedOrgToDb(userId: string, orgId: string) {
    const settingsRef = doc(this.firestore as any, `userSettings/${userId}`);
    await setDoc(settingsRef as any, { currentOrgUid: orgId }, { merge: true });
  }
}
