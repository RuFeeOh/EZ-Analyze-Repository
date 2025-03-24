import { inject, Injectable } from '@angular/core';
import { addDoc, collection } from 'firebase/firestore';
import { SampleInfo } from '../../models/sample-info.model';
import { Firestore } from '@angular/fire/firestore';
import { ExposureGroup } from '../../models/exposure-group.model';
import { ExceedanceFraction } from '../../models/exceedance-fraction.model';

@Injectable({
  providedIn: 'root'
})
export class ExposureGroupService {
  private firestore = inject(Firestore);

  constructor() { }

  async saveSampleInfo(sampleInfo: SampleInfo[], organizationUid: string, organizationName: string) {
    try {
      // Transform SampleInfo into ExposureGroup
      const exposureGroup = new ExposureGroup({
        OrganizationUid: organizationUid,
        OrganizationName: organizationName,
        Group: sampleInfo[0].ExposureGroup,
        ExposureGroup: sampleInfo[0].ExposureGroup,
        // Results: sampleInfo,
        LatestExceedanceFraction: new ExceedanceFraction({
          DateCalculated: new Date().toISOString(),
          OELNumber: 0.05, // Default value, can be adjusted as needed
          MostRecentNumber: 1, // Since we're adding the first sample
          ResultsUsed: [] // This would need to be populated with ExposureGroupResult objects
        }),
        ExceedanceFractionHistory: []
      });


      const newMessageRef = await addDoc(
        collection(this.firestore, "exposureGroups"),
        JSON.parse(JSON.stringify(exposureGroup)), // Convert to plain object for Firestore
      );

      return newMessageRef;
    } catch (error) {
      console.log("There was a problem saving exposure group", error);
      throw error;
    }
  }
}
