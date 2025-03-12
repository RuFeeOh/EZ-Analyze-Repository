import { Component, inject } from '@angular/core';
import { Firestore } from '@angular/fire/firestore';
import { MatButtonModule } from '@angular/material/button';
import { addDoc, collection } from 'firebase/firestore';

@Component({
  selector: 'app-organization-selector',
  imports: [MatButtonModule],
  templateUrl: './organization-selector.component.html',
  styleUrl: './organization-selector.component.scss'
})
export class OrganizationSelectorComponent {
  private firestore = inject(Firestore)
  public organizationList: string[] = ["Covia", "New Corp", "JamieCorp", "StinkiesCorp", "ZacCrop"];
  async saveOrganization() {
    try {
      const newMessageRef = await addDoc(
        collection(this.firestore, "organizations"),
        {
          Name: "poopsicle"
        },
      );
      return newMessageRef;
    } catch (error) {
      console.log("there was a problem saving orgs", error)
    }
    return null

  }
}
