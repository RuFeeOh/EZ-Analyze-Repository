import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Auth, GoogleAuthProvider, signInWithPopup, signOut, user } from '@angular/fire/auth';
import { MatButtonModule } from '@angular/material/button';
import { Router } from '@angular/router';


@Component({
  selector: 'ez-login',
  imports: [
    CommonModule,
    MatButtonModule,
  ],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  private router = inject(Router);
  public user;
  constructor(public auth: Auth) {
    this.user = user(this.auth)
  }

  async login() {
    await signInWithPopup(this.auth, new GoogleAuthProvider());
    // navigate to home page
    this.router.navigate(['/home']);
  }

  logout() {
    signOut(this.auth);
  }
}
