import { Component, EventEmitter, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { OrganizationCircleComponent } from '../organization-circle/organization-circle.component';
import { OrganizationService } from '../../services/organization/organization.service';
import { Auth, signOut } from '@angular/fire/auth';
import { Router } from '@angular/router';

@Component({
    selector: 'app-header',
    standalone: true,
    imports: [CommonModule, MatToolbarModule, MatButtonModule, MatIconModule, MatMenuModule, OrganizationCircleComponent],
    templateUrl: './header.component.html',
    styleUrl: './header.component.scss'
})
export class HeaderComponent {
    @Output() menuClick = new EventEmitter<void>();
    public organizationService = inject(OrganizationService);
    private auth = inject(Auth);
    private router = inject(Router);

    onMenuClick() {
        this.menuClick.emit();
    }

    async logout() {
        try {
            this.organizationService.clearCurrentOrg();
            await signOut(this.auth);
        } catch {
            // No-op
        }
    }

    goToOrg() {
        this.router.navigateByUrl('/org');
    }
}
