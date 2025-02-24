import { Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'app-organization-selector',
  imports: [MatButtonModule],
  templateUrl: './organization-selector.component.html',
  styleUrl: './organization-selector.component.scss'
})
export class OrganizationSelectorComponent {
  public organizationList: string[] = ["Covia", "New Corp", "JamieCorp", "StinkiesCorp", "ZacCrop"];
}
