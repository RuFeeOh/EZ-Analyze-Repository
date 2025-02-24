import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import {MatButtonModule} from '@angular/material/button';
import { OrganizationSelectorComponent } from './pages/organization-selector/organization-selector.component';
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, MatButtonModule, OrganizationSelectorComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  title = 'EZAnalyze';
}
