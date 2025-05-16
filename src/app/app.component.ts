import { Component, inject, computed, effect, signal, linkedSignal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { LoginComponent } from './pages/login/login.component';
import { OrganizationService } from './services/organization/organization.service';
import { Auth, User, user } from '@angular/fire/auth';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { toSignal } from '@angular/core/rxjs-interop';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatButtonModule,
    MatSidenavModule,
    MatListModule,
    LoginComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'EZAnalyze';
  // inject orgazination service
  public organizationService = inject(OrganizationService);

  private auth = inject(Auth);
  private _user$ = user(this.auth);
  private _user = toSignal(this._user$, { initialValue: null });
  public isLoggedIn = linkedSignal<User | null, boolean>({
    source: this._user,
    computation: (user) => {
      return !!user;
    }
  });
}
