import { Component, inject } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { MatButtonModule } from '@angular/material/button';
import { addDoc, collection } from 'firebase/firestore';
import { OrganizationService } from '../../services/organization/organization.service';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { CommonModule } from '@angular/common';
import { Organization } from '../../models/organization.model';
import { Auth } from '@angular/fire/auth';

@Component({
  selector: 'app-organization-selector',
  imports: [MatButtonModule, FormsModule, MatFormFieldModule, MatInputModule, CommonModule],
  templateUrl: './organization-selector.component.html',
  styleUrl: './organization-selector.component.scss'
})
export class OrganizationSelectorComponent {
  private firestore = inject(Firestore);
  private organizationService = inject(OrganizationService);
  public organizationName = "";
  public organizationList = this.organizationService.organizationList;
  async saveOrganization() {
    console.log("saving org", this.organizationName);

    try {
      await this.organizationService.saveOrganization(this.organizationName);
      this.organizationName = "";
      return;
    } catch (error) {
      console.log("there was a problem saving orgs", error)
    }
    finally {
    }
    return null

  }

  async setOrganization(org: Organization) {
    console.log("setting org in component", org);
    this.organizationService.setCurrentOrg(org);
  }

}
