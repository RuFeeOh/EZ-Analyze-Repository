import { Component, inject } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { OrganizationService } from './services/organization/organization.service';
import { CommonModule } from '@angular/common';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { Auth, GoogleAuthProvider, signInWithPopup, signOut, user } from '@angular/fire/auth';

@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatButtonModule,
    MatSidenavModule,
    MatListModule,
    MatToolbarModule,
    MatIconModule,
    MatMenuModule,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'EZAnalyze';
  // inject services
  public organizationService = inject(OrganizationService);
  public auth = inject(Auth);
  public user$ = user(this.auth);

  async login() {
    try {
      await signInWithPopup(this.auth, new GoogleAuthProvider());
    } catch {
      // No-op
    }
  }

  async logout() {
    try {
      this.organizationService.clearCurrentOrg();
      await signOut(this.auth);
    } catch {
      // No-op
    }
  }
}
