import { Component, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatSidenavModule, MatDrawer } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { OrganizationService } from '../../services/organization/organization.service';
import { AgentService } from '../../services/agent/agent.service';
import { toSignal } from '@angular/core/rxjs-interop';

@Component({
    selector: 'app-left-navigation',
    standalone: true,
    imports: [CommonModule, MatSidenavModule, MatListModule, RouterLink, RouterLinkActive, RouterOutlet],
    templateUrl: './left-navigation.component.html',
    styleUrl: './left-navigation.component.scss'
})
export class LeftNavigationComponent {
    public organizationService = inject(OrganizationService);
    private agentService = inject(AgentService);
    public router = inject(Router);
    public agents = toSignal(this.agentService.agents$, { initialValue: [] });

    @ViewChild('drawer') drawer?: MatDrawer;

    toggle() {
        this.drawer?.toggle();
    }

    trackAgent = (_: number, a: any) => a?.Name || a;
}
