import { Component, ViewChild, inject } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { OrganizationService } from './services/organization/organization.service';
import { CommonModule } from '@angular/common';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { Auth, GoogleAuthProvider, signInWithPopup, signOut, user } from '@angular/fire/auth';
import { OrganizationCircleComponent } from './features/organization-circle/organization-circle.component';
import { LeftNavigationComponent } from './features/left-navigation/left-navigation.component';
import { HeaderComponent } from './features/header/header.component';

@Component({
  selector: 'app-root',
  imports: [
    CommonModule,
    MatButtonModule,
    MatSidenavModule,
    MatListModule,
    MatToolbarModule,
    MatIconModule,
    MatMenuModule,
    LeftNavigationComponent,
    HeaderComponent,
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
  private router = inject(Router);
  @ViewChild('leftNav') leftNav?: LeftNavigationComponent;

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

  goToOrg() {
    this.router.navigateByUrl('/org');
  }
}
