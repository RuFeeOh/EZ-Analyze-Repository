import { inject, Injectable } from '@angular/core';
import { addDoc, collection } from 'firebase/firestore';
import { SampleInfo } from '../../models/sample-info.model';
import { Firestore } from '@angular/fire/firestore';
import { ExposureGroup } from '../../models/exposure-group.model';
import { ExceedanceFraction } from '../../models/exceedance-fraction.model';
import { ExceedanceFractionService } from '../exceedance-fraction/exceedance-fraction.service';


@Injectable({
  providedIn: 'root'
})
export class ExposureGroupService {
  private firestore = inject(Firestore);
  private exceedanceFractionservice = inject(ExceedanceFractionService)

  constructor() { }

  async saveSampleInfo(sampleInfo: SampleInfo[], organizationUid: string, organizationName: string) {
    try {
      const TWAlist: number[] = this.getTWAListFromSampleInfo(sampleInfo);
      const exceedanceFraction = this.exceedanceFractionservice.calculateExceedanceProbability(TWAlist, 0.05);
      alert(exceedanceFraction);

      const latestExceedanceFraction = this.createExceedanceFraction(exceedanceFraction, TWAlist, sampleInfo);
      // Transform SampleInfo into ExposureGroup
      const exposureGroup = new ExposureGroup({
        OrganizationUid: organizationUid,
        OrganizationName: organizationName,
        Group: sampleInfo[0].ExposureGroup,
        ExposureGroup: sampleInfo[0].ExposureGroup,
        Results: sampleInfo,
        LatestExceedanceFraction: latestExceedanceFraction,
        ExceedanceFractionHistory: [
          latestExceedanceFraction
        ]
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

  private createExceedanceFraction(exceedanceFraction: number, TWAlist: number[], sampleInfo: SampleInfo[]) {
    return new ExceedanceFraction({
      ExceedanceFraction: exceedanceFraction,
      DateCalculated: new Date().toISOString(),
      OELNumber: 0.05, // Default value, can be adjusted as needed
      MostRecentNumber: TWAlist.length, // Since we're adding the first sample
      ResultsUsed: sampleInfo,
    });
  }

  public getTWAListFromSampleInfo(sampleInfo: SampleInfo[]): number[] {

    let doesSampleInfoContainZero = false;
    const TWAlist: number[] = [];
    sampleInfo
      //.filter(sample => sample.ExposureGroup === "TROUP MINING EQUIPMENT OPERATOR")
      .forEach((sample) => {
        if (sample.TWA && +sample.TWA > 0) {
          TWAlist.push(+sample.TWA)
        } else if (+sample.TWA === 0) {
          // throw new Error('Data contains zeros')
          doesSampleInfoContainZero = true;
        }

      });

    if (doesSampleInfoContainZero) {
      alert('Data contains zeros');
    }
    return TWAlist;
  }

}
