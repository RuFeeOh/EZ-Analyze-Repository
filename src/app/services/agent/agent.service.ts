import { inject, Injectable, EnvironmentInjector } from '@angular/core';
import { Firestore, collection, collectionData, CollectionReference, doc, setDoc, deleteDoc, getDoc } from '@angular/fire/firestore';
import { serverTimestamp } from 'firebase/firestore';
import { Auth } from '@angular/fire/auth';
import { Agent } from '../../models/agent.model';
import { Observable } from 'rxjs';
import { createInjectionContext } from '../../utils/create-injection-context.decorator';

@Injectable({ providedIn: 'root' })
export class AgentService {
    private firestore = inject(Firestore);
    private auth = inject(Auth);
    private env = inject(EnvironmentInjector);

    private agentsRef(orgId: string): CollectionReference {
        return collection(this.firestore as any, `organizations/${orgId}/agents`) as any;
    }

    @createInjectionContext()
    list(orgId: string): Observable<Agent[]> {
        return collectionData(this.agentsRef(orgId) as any, { idField: 'Uid' }) as any;
    }

    @createInjectionContext()
    async upsert(orgId: string, agent: Agent): Promise<void> {
        const id = this.slug(agent.Name);
        const ref = doc(this.agentsRef(orgId) as any, id);
        const uid = this.auth.currentUser?.uid || 'unknown';
        const base: any = { ...agent, Uid: id };
        const snap = await getDoc(ref as any);
        if (snap.exists()) {
            // Update only
            await setDoc(ref as any, { ...base, updatedAt: serverTimestamp(), updatedBy: uid }, { merge: true });
        } else {
            // Create with created*/updated*
            await setDoc(ref as any, { ...base, createdAt: serverTimestamp(), createdBy: uid, updatedAt: serverTimestamp(), updatedBy: uid }, { merge: true });
        }
    }

    async remove(orgId: string, name: string): Promise<void> {
        const id = this.slug(name);
        await deleteDoc(doc(this.agentsRef(orgId) as any, id));
    }

    private slug(v: string): string {
        return (v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 120) || 'agent';
    }
}
