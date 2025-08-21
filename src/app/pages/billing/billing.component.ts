import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { BillingService } from '../../services/billing/billing.service';

@Component({
    selector: 'app-billing',
    standalone: true,
    imports: [CommonModule, MatButtonModule, MatFormFieldModule, MatInputModule],
    template: `
  <h2>Billing</h2>
  <p>Subscribe to unlock sharing and higher exposure group limits.</p>
  <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
    <button mat-raised-button color="primary" (click)="subscribe('price_PROFESSIONAL')">Subscribe (Professional)</button>
    <button mat-raised-button color="primary" (click)="subscribe('price_ENTERPRISE')">Subscribe (Enterprise)</button>
    <button mat-stroked-button (click)="manageBilling()">Manage Billing</button>
  </div>
  `,
})
export class BillingComponent {
    private billing = inject(BillingService);

    async subscribe(priceId: string) {
        await this.billing.startCheckout(priceId);
    }

    async manageBilling() {
        // In a real app you would look up the Stripe customer id for this user
        const customerId = prompt('Enter your Stripe customer ID');
        if (customerId) await this.billing.openPortal(customerId);
    }
}
