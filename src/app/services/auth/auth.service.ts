import { Injectable } from '@angular/core';
import { Auth, GoogleAuthProvider, signInWithPopup, signOut } from '@angular/fire/auth';

@Injectable({
    providedIn: 'root'
})
export class AuthService {
    constructor(private auth: Auth) { }

    async signInWithGoogle(): Promise<void> {
        const provider = new GoogleAuthProvider();
        try {
            await signInWithPopup(this.auth, provider);
            console.log('User signed in successfully');
        } catch (error) {
            console.error('Error during sign-in:', error);
        }
    }

    async logout(): Promise<void> {
        try {
            await signOut(this.auth);
            console.log('User signed out successfully');
        } catch (error) {
            console.error('Error during sign-out:', error);
        }
    }
}