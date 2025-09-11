import { Provider } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { Auth } from '@angular/fire/auth';

// Very lightweight stubs for AngularFire dependencies so most standalone
// component/service specs don't fail due to missing DI providers.
// Minimal shape to satisfy the firebase collection() helper: it just needs to
// be an object we can pass back through without throwing.
export const fireStoreStub: any = {
    _tag: 'MockFirestore'
};

export const authStub = {
    currentUser: null
};

export const commonTestProviders: Provider[] = [
    { provide: Firestore, useValue: fireStoreStub },
    { provide: Auth, useValue: authStub }
];
