import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { Auth, GoogleAuthProvider, signInWithPopup, signOut, user } from '@angular/fire/auth';


@Component({
  selector: 'app-login',
  imports: [CommonModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent {
  public user;
  constructor(public auth: Auth) {
    this.user = user(this.auth)
  }

  login() {
    signInWithPopup(this.auth, new GoogleAuthProvider());
  }

  logout() {
    signOut(this.auth);
  }
}
