import { inject, Injectable, EnvironmentInjector, runInInjectionContext } from '@angular/core';
import { Firestore, docData } from '@angular/fire/firestore';
import { doc } from 'firebase/firestore';
import { Subscription } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class EfRecomputeTrackerService {
    private firestore = inject(Firestore);
    private env = inject(EnvironmentInjector);

    async waitForEf(
        orgId: string,
        ids: string[],
        startIso: string,
        onProgress?: (done: number, total: number) => void,
        timeoutMs = 99999999
    ): Promise<{ timedOut: boolean }> {
        const uniqueIds = Array.from(new Set(ids || []));
        const total = uniqueIds.length;
        if (total === 0) return { timedOut: false };
        const startTs = Date.parse(startIso || '');
        let done = 0;
        const subscriptions: Subscription[] = [];

        const progress = () => onProgress?.(done, total);
        progress();

        const cleanup = () => {
            subscriptions.splice(0).forEach(s => { try { s.unsubscribe(); } catch { } });
        };

        const toMillis = (v: any): number => {
            if (!v) return 0;
            // Support Firestore Timestamp, Date, or ISO string
            try {
                if (typeof v.toMillis === 'function') return v.toMillis();
                if (v instanceof Date) return v.getTime();
                if (typeof v === 'string') return Date.parse(v);
            } catch { }
            return 0;
        };

        const completion = new Promise<boolean>((resolve) => {
            uniqueIds.forEach(id => {
                const ref = doc(this.firestore as any, `organizations/${orgId}/exposureGroups/${id}`);
                // Create the AngularFire observable within Angular's injection context
                const source$ = runInInjectionContext(this.env, () => docData(ref as any));
                const sub = source$.subscribe({
                    next: (data: any) => {
                        const latest: any = data?.LatestExceedanceFraction;
                        const whenLatest = toMillis(latest?.DateCalculated);
                        const efComputedAt = toMillis(data?.EFComputedAt);
                        const when = Math.max(whenLatest, efComputedAt);
                        if (when && when >= startTs) {
                            done += 1;
                            progress();
                            // complete this stream's work
                            try { sub.unsubscribe(); } catch { }
                            if (done >= total) {
                                cleanup();
                                resolve(false); // not timed out
                            }
                        }
                    },
                    error: () => {
                        // If we cannot observe the doc (e.g., permissions), don't hang the UI.
                        done += 1;
                        progress();
                        try { sub.unsubscribe(); } catch { }
                        if (done >= total) {
                            cleanup();
                            resolve(false);
                        }
                    }
                });
                subscriptions.push(sub);
            });
        });

        const timeout = new Promise<boolean>(res => setTimeout(() => {
            cleanup();
            res(true);
        }, timeoutMs));

        const timedOut = await Promise.race([completion, timeout]);
        return { timedOut };
    }
}
