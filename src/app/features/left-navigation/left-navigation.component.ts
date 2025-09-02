import { Component, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatSidenavModule, MatDrawer } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { OrganizationService } from '../../services/organization/organization.service';

@Component({
    selector: 'app-left-navigation',
    standalone: true,
    imports: [CommonModule, MatSidenavModule, MatListModule, RouterLink, RouterLinkActive, RouterOutlet],
    templateUrl: './left-navigation.component.html',
    styleUrl: './left-navigation.component.scss'
})
export class LeftNavigationComponent {
    public organizationService = inject(OrganizationService);
    @ViewChild('drawer') drawer?: MatDrawer;

    toggle() {
        this.drawer?.toggle();
    }
}
