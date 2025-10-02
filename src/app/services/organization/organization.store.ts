import { computed, effect, EnvironmentInjector, inject, Injectable, OnInit, runInInjectionContext, signal, Signal, untracked, WritableSignal } from "@angular/core";
import { Organization } from "../../models/organization.model";
import { collectionData } from "@angular/fire/firestore";
import { Firestore } from '@angular/fire/firestore'
import { collection, query, where } from "firebase/firestore";
import { Observable, defer, map, catchError, of, switchMap, tap } from "rxjs";
import { Auth, User, user } from "@angular/fire/auth";
import { toSignal } from '@angular/core/rxjs-interop';
import { UserService } from "../user/user.service";

class OrganizationStoreState {
    currentOrg: Organization | null = null;
    organizationList: Organization[] = [];
    isLoadingOrganizations: boolean = false;
    isErrorLoadingOrganizations: boolean = false;
}
@Injectable({
    providedIn: 'root'
})
export class OrganizationStore {

    private firestore = inject(Firestore);
    private auth = inject(Auth);

    private env = inject(EnvironmentInjector);
    private userService = inject(UserService);
    private _state: WritableSignal<OrganizationStoreState> = signal(new OrganizationStoreState());

    private state = computed(() => this._state());
    public organizationList = computed(() => this.state().organizationList);
    public currentOrg = computed(() => this.state().currentOrg);
    public isLoadingOrganizations = computed(() => this.state().isLoadingOrganizations);
    public isErrorLoadingOrganizations = computed(() => this.state().isErrorLoadingOrganizations);

    // Reactive user via AngularFire Auth
    private user$ = this.userService.user$;
    private userSig = toSignal(this.user$, { initialValue: null });
    private userUid = computed(() => this.userSig()?.uid ?? null);

    private organizationList$: Observable<Organization[]> = this.user$.pipe(
        tap(() => this.updateState({
            isLoadingOrganizations: true,
            isErrorLoadingOrganizations: false
        })),
        this.mapUserToOrganizationList(),
        tap((orgList) => this.updateState({
            isLoadingOrganizations: false,
            organizationList: orgList
        })),
        catchError((error) => {
            console.error(error);
            this.updateState({
                isLoadingOrganizations: false,
                isErrorLoadingOrganizations: true,
                organizationList: []
            });
            return of([]);
        })
    );
    public organizationListSignal: Signal<Organization[]> = toSignal(this.organizationList$, { initialValue: [] });


    constructor() {
        effect(() => {
            const userId = untracked(this.userUid);
            const orgList = this.organizationListSignal();
            const isLoading = untracked(this.isLoadingOrganizations);
            const currentOrg: Organization | null = untracked(this.currentOrg);

            if (userId && !isLoading) {
                if (
                    orgList.some(o => o.Uid === currentOrg?.Uid)
                ) {
                    this.updateState({
                        currentOrg: currentOrg
                    });
                } else {
                    this.clearCurrentOrg();
                }
            }
        });
    }

    private mapUserToOrganizationList(): (source: Observable<User | null>) => Observable<Organization[]> {
        return switchMap((user: User | null) => {
            if (user) {
                return this.loadUserOrganizations(user);
            } else {
                return this.returnEmptyOrganizations();
            }
        });
    }

    private returnEmptyOrganizations() {
        this.updateState({
            isLoadingOrganizations: false,
            isErrorLoadingOrganizations: false
        });
        return of([]);
    }

    private loadUserOrganizations(user: User): Observable<Organization[]> {

        return this.getOrganizationList(user.uid ?? '').pipe(
            tap(() => {
                this.updateState({
                    isLoadingOrganizations: false,
                    isErrorLoadingOrganizations: false
                });
            })
        );
    }

    // Build a per-uid organizations signal using toSignal over the observable
    private organizationsFor(uid: string): Signal<Organization[]> {
        const obs$ = this.getOrganizationList(uid);
        return toSignal(obs$, { initialValue: [] });
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
                this.updateState({ isErrorLoadingOrganizations: true });
                return of([]);
            })
        );
    }

    public setCurrentOrg(org: Organization | null) {
        this.updateState({ currentOrg: org });
        if (org) {
            localStorage.setItem('currentOrg', JSON.stringify(org));
        } else {
            localStorage.removeItem('currentOrg');
        }
    }

    public clearCurrentOrg() {
        this.updateState({ currentOrg: null });
        localStorage.removeItem('currentOrg');
    }

    private updateState(partial: Partial<OrganizationStoreState>) {
        this._state.update((state) => ({
            ...state,
            ...partial
        }));
    }


}