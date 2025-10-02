import { inject, Injectable } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Auth, user } from '@angular/fire/auth';
import { debounceTime } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class UserService {

  private auth = inject(Auth);
  public user$ = user(this.auth).pipe(debounceTime(100));
  public user = toSignal(this.user$, { initialValue: null });
  public userUid = () => this.user()?.uid ?? null;

}
