import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Auth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, user } from '@angular/fire/auth';
import { Router } from '@angular/router';
import { OrganizationService } from '../../services/organization/organization.service';


@Component({
  selector: 'app-login',
  imports: [CommonModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  public user;
  private router = inject(Router);
  private organizationService = inject(OrganizationService);
  constructor(public auth: Auth) {
    this.user = user(this.auth)
  }

  async login() {
    try {
      // First, check if we're coming back from a redirect
      try { await getRedirectResult(this.auth); } catch { /* ignore */ }
      try {
        await signInWithPopup(this.auth, new GoogleAuthProvider());
      } catch (e: any) {
        // Popup may fail in emulator on reloads; fall back to redirect
        await signInWithRedirect(this.auth, new GoogleAuthProvider());
        return;
      }
      // After successful login, navigate to organization selector
      this.router.navigateByUrl('/org');
    } catch (e) {
      // No-op; allow UI to handle auth errors if needed
    }
  }

  logout() {
    this.organizationService.clearCurrentOrg();
    signOut(this.auth);
  }
}
