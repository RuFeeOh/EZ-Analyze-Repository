import { CommonModule } from '@angular/common';
import { Component, InputSignal, OutputEmitterRef, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Organization } from '../../models/organization.model';

@Component({
  selector: 'organization-circle',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatTooltipModule],
  templateUrl: './organization-circle.component.html',
  styleUrl: './organization-circle.component.scss'
})
export class OrganizationCircleComponent {
  org: InputSignal<Organization | null> = input<Organization | null>(null);
  orgClicked: OutputEmitterRef<Organization | null> = output<Organization | null>();
}
