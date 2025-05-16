import { inject, Injectable } from '@angular/core';
import { addDoc, collection, getDocs, query, where, setDoc, doc } from 'firebase/firestore';
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
      const groupedSampleInfo = this.separateSampleInfoByExposureGroup(sampleInfo);

      for (const exposureGroupName in groupedSampleInfo) {
        const groupSamples = groupedSampleInfo[exposureGroupName];
        await this.processExposureGroup(groupSamples, organizationUid, organizationName);
      }
    } catch (error) {
      console.log("There was a problem saving exposure group", error);
      throw error;
    }
  }

  private async processExposureGroup(sampleInfo: SampleInfo[], organizationUid: string, organizationName: string) {
    const TWAlist: number[] = this.getTWAListFromSampleInfo(sampleInfo);
    const exceedanceFraction = this.exceedanceFractionservice.calculateExceedanceProbability(TWAlist, 0.05);
    alert(exceedanceFraction);

    const latestExceedanceFraction = this.createExceedanceFraction(exceedanceFraction, TWAlist, sampleInfo);

    const existingExposureGroups = await getDocs(query(
      collection(this.firestore, 'exposureGroups'),
      where('OrganizationUid', '==', organizationUid),
      where('ExposureGroup', '==', sampleInfo[0].ExposureGroup)
    ));

    if (!existingExposureGroups.empty) {
      const existingGroup = existingExposureGroups.docs[0].data();

      const duplicateSample = this.checkForDuplicateSamples(existingGroup['Results'], sampleInfo);

      if (duplicateSample) {
        alert('Duplicate sample data found. Data will not be saved.');
        throw new Error('Duplicate sample data found. Data will not be saved.');
      }

      existingGroup['Results'].push(...sampleInfo);
      existingGroup['LatestExceedanceFraction'] = latestExceedanceFraction;
      existingGroup['ExceedanceFractionHistory'].push(latestExceedanceFraction);

      await setDoc(doc(this.firestore, 'exposureGroups', existingExposureGroups.docs[0].id), existingGroup);
    } else {
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

      await addDoc(collection(this.firestore, 'exposureGroups'), JSON.parse(JSON.stringify(exposureGroup)));
    }
  }

  private checkForDuplicateSamples(existingSamples: SampleInfo[], newSamples: SampleInfo[]): boolean {
    return existingSamples.some((existingSample: SampleInfo) =>
      newSamples.some(newSample => newSample.SampleNumber === existingSample.SampleNumber)
    );
  }

  /**
     * Separates an array of SampleInfo objects into groups based on their ExposureGroup.
     * 
     * @param sampleInfo An array of SampleInfo objects to be grouped
     * @returns An object where keys are ExposureGroup names and values are arrays of corresponding SampleInfo objects
     */
  public separateSampleInfoByExposureGroup(sampleInfo: SampleInfo[]): { [key: string]: SampleInfo[] } {
    const result: { [key: string]: SampleInfo[] } = {};
    sampleInfo.forEach((sample) => {
      if (!result[sample.ExposureGroup]) {
        result[sample.ExposureGroup] = [];
      }
      result[sample.ExposureGroup].push(sample);
    });
    return result;
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
