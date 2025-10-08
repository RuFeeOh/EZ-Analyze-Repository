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
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { OrganizationCircleComponent } from '../../features/organization-circle/organization-circle.component';

@Component({
  selector: 'app-organization-selector',
  imports: [MatButtonModule, FormsModule, MatFormFieldModule, MatInputModule, MatIconModule, MatMenuModule, MatTooltipModule, CommonModule, OrganizationCircleComponent],
  templateUrl: './organization-selector.component.html',
  styleUrl: './organization-selector.component.scss'
})
export class OrganizationSelectorComponent {
  private firestore = inject(Firestore);
  private organizationService = inject(OrganizationService);
  public organizationName = "";
  public organizationList = this.organizationService.organizationList;
  public saving = false;
  public currentOrg = this.organizationService.orgStore.currentOrg;
  public editingOrgId: string | null = null;
  public editingOrgName = "";
  
  async saveOrganization() {
    console.log("saving org", this.organizationName);

    try {
      this.saving = true;
      await this.organizationService.saveOrganization(this.organizationName);
      this.organizationName = "";
      return;
    } catch (error) {
      console.log("there was a problem saving orgs", error)
    }
    finally {
      this.saving = false;
    }
    return null

  }

  async setOrganization(org: Organization) {
    console.log("setting org in component", org);
    this.organizationService.setCurrentOrg(org);
  }

  async confirmDelete(org: Organization) {
    const ok = confirm(`Delete organization "${org.Name}"? This cannot be undone.`);
    if (!ok) return;
    try {
      this.saving = true;
      await this.organizationService.deleteOrganization(org.Uid);
    } catch (e) {
      console.error('Failed to delete org', e);
    } finally { this.saving = false; }
  }

  startRename(org: Organization) {
    this.editingOrgId = org.Uid;
    this.editingOrgName = org.Name;
  }

  cancelRename() {
    this.editingOrgId = null;
    this.editingOrgName = "";
  }

  async saveRename(org: Organization) {
    if (!this.editingOrgName.trim()) return;
    if (this.editingOrgName === org.Name) {
      this.cancelRename();
      return;
    }
    
    try {
      this.saving = true;
      await this.organizationService.renameOrganization(org.Uid, this.editingOrgName);
      this.cancelRename();
    } catch (e) {
      console.error('Failed to rename org', e);
    } finally {
      this.saving = false;
    }
  }

}
