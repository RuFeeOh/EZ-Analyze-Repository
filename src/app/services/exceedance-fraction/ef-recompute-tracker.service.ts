import { inject, Injectable } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { doc, onSnapshot } from 'firebase/firestore';

@Injectable({ providedIn: 'root' })
export class EfRecomputeTrackerService {
    private firestore = inject(Firestore);

    async waitForEf(
        orgId: string,
        ids: string[],
        startIso: string,
        onProgress?: (done: number, total: number) => void,
        timeoutMs = 99999999
    ): Promise<{ timedOut: boolean }> {
        const total = ids.length;
        if (total === 0) return { timedOut: false };
        const startTs = Date.parse(startIso || '');
        let done = 0;
        const unsubscribes: Array<() => void> = [];

        const progress = () => onProgress?.(done, total);
        progress();

        const completion = new Promise<void>((resolve) => {
            ids.forEach(id => {
                const ref = doc(this.firestore as any, `organizations/${orgId}/exposureGroups/${id}`);
                const unsub = onSnapshot(ref as any, (snap: any) => {
                    const data: any = snap.data();
                    const latest: any = data?.LatestExceedanceFraction;
                    const when = latest?.DateCalculated ? Date.parse(latest.DateCalculated) : 0;
                    if (when && when >= startTs) {
                        done += 1;
                        progress();
                        unsub();
                    }
                    if (done >= total) {
                        resolve();
                    }
                });
                unsubscribes.push(unsub);
            });
        }).finally(() => {
            unsubscribes.forEach(u => { try { u(); } catch { } });
        });

        const timedOut = await Promise.race([
            completion.then(() => false),
            new Promise<boolean>(res => setTimeout(() => res(true), timeoutMs))
        ]);
        return { timedOut };
    }
}
