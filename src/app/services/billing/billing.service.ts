import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class BillingService {
    private http = inject(HttpClient);

    async startCheckout(priceId: string, customerEmail?: string, orgId?: string): Promise<void> {
        const url = `/api/createCheckoutSession`;
        const res = await this.http.post<{ url: string }>(url, { priceId, customerEmail, orgId }).toPromise();
        if (res?.url) {
            window.location.href = res.url;
        } else {
            throw new Error('Failed to create checkout session');
        }
    }

    async openPortal(customerId: string): Promise<void> {
        const url = `/api/createPortalSession`;
        const res = await this.http.post<{ url: string }>(url, { customerId }).toPromise();
        if (res?.url) {
            window.location.href = res.url;
        } else {
            throw new Error('Failed to create portal session');
        }
    }
}
