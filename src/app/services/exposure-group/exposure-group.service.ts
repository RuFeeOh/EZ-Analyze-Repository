import { inject, Injectable } from '@angular/core';
import { collection, doc, runTransaction } from 'firebase/firestore';
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
      // Deterministic document ID within org: slug(group)
      const groupName = sampleInfo[0]?.ExposureGroup || 'unknown-group';
      const docId = this.slugify(groupName);
      const colRef = collection(this.firestore, `organizations/${organizationUid}/exposureGroups`);
      const docRef = doc(colRef, docId);

      // Upsert using a transaction to atomically concatenate results
      await runTransaction(this.firestore, async (tx) => {
        const snap = await tx.get(docRef as any);
        const existingData: any = snap.exists() ? (snap.data() || {}) : {};
        const existingResults: SampleInfo[] = (existingData?.Results ?? []) as SampleInfo[];

        // Merge results first; EF will be recomputed on the server via Cloud Function
        const updatedResults: SampleInfo[] = [...existingResults, ...sampleInfo];

        if (!snap.exists()) {
          // Create new document WITHOUT EF fields (server computes them)
          const payload = {
            OrganizationUid: organizationUid,
            OrganizationName: organizationName,
            Group: groupName,
            ExposureGroup: groupName,
            Results: JSON.parse(JSON.stringify(updatedResults))
          };
          tx.set(docRef as any, payload as any);
        } else {
          // Update existing: concat results; EF fields updated server-side
          tx.update(docRef as any, {
            Results: JSON.parse(JSON.stringify(updatedResults)),
            // keep id fields consistent
            OrganizationUid: organizationUid,
            OrganizationName: organizationName,
            Group: groupName,
            ExposureGroup: groupName,
          });
        }
      });

      return docRef;
    } catch (error) {
      console.log("There was a problem saving exposure group", error);
      throw error;
    }
  }

  /**
   * Save multiple exposure groups in a single transaction. The input is a map of groupName -> SampleInfo[]
   * For each group, merges Results, recomputes EF from last 6 samples, updates Latest/History, and upserts the doc.
   * Returns an array of { id: string, groupName: string } for saved docs.
   */
  async saveGroupedSampleInfo(groups: { [groupName: string]: SampleInfo[] }, organizationUid: string, organizationName: string) {
    const colRef = collection(this.firestore, `organizations/${organizationUid}/exposureGroups`);
    const entries = Object.entries(groups || {}).filter(([_, arr]) => (arr?.length ?? 0) > 0);
    if (entries.length === 0) return [];

    const result = await runTransaction(this.firestore, async (tx) => {
      const saved: { id: string, groupName: string }[] = [];

      // Pass 1: Read all docs first
      const docs = await Promise.all(entries.map(async ([groupNameRaw, samples]) => {
        const groupName = groupNameRaw || samples[0]?.ExposureGroup || 'unknown-group';
        const docId = this.slugify(groupName);
        const docRefInst = doc(colRef, docId);
        const snap = await tx.get(docRefInst as any);
        const existingData: any = snap.exists() ? (snap.data() || {}) : {};
        return { groupName, docId, docRefInst, snap, existingData, samples };
      }));

      // Pass 2: Compute updates and write (EF fields updated server-side)
      for (const d of docs) {
        const existingResults: SampleInfo[] = (d.existingData?.Results ?? []) as SampleInfo[];
        const updatedResults: SampleInfo[] = [...existingResults, ...d.samples];

        if (!d.snap.exists()) {
          const payload = {
            OrganizationUid: organizationUid,
            OrganizationName: organizationName,
            Group: d.groupName,
            ExposureGroup: d.groupName,
            Results: JSON.parse(JSON.stringify(updatedResults))
          };
          tx.set(d.docRefInst as any, payload as any);
        } else {
          tx.update(d.docRefInst as any, {
            Results: JSON.parse(JSON.stringify(updatedResults)),
            OrganizationUid: organizationUid,
            OrganizationName: organizationName,
            Group: d.groupName,
            ExposureGroup: d.groupName,
          });
        }
        saved.push({ id: d.docId, groupName: d.groupName });
      }
      return saved;
    });
    return result;
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
          doesSampleInfoContainZero = true;
        }

      });
    return TWAlist;
  }

  /**
   * Converts a given text string into a URL-friendly slug.
   * 
   * The slug is generated by:
   * - Converting the text to lowercase.
   * - Trimming whitespace from both ends of the string.
   * - Replacing spaces with hyphens (`-`).
   * - Removing all characters except lowercase letters, numbers, and hyphens.
   * - Collapsing consecutive hyphens into a single hyphen.
   * - Limiting the resulting slug to a maximum of 120 characters.
   * 
   * @param text - The input string to be converted into a slug.
   * @returns A URL-friendly slug derived from the input text.
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\-]/g, '')
      .replace(/-+/g, '-')
      .slice(0, 120);
  }

  /**
   * Select up to `max` most recent samples by SampleDate (descending).
   * Only includes samples with TWA > 0.
   */
  private getMostRecentSamples(results: SampleInfo[], max: number = 6): SampleInfo[] {
    const candidates = (results || []).filter(r => r && Number(r.TWA) > 0);
    const sorted = [...candidates].sort((a, b) => this.parseDateToEpoch(b.SampleDate) - this.parseDateToEpoch(a.SampleDate));
    return sorted.slice(0, Math.min(max, sorted.length));
  }

  /**
   * Parses a date string into an epoch milliseconds number. If invalid, returns 0.
   */
  private parseDateToEpoch(dateStr: string | undefined | null): number {
    if (!dateStr) return 0;
    const d = new Date(dateStr);
    const t = d.getTime();
    return isNaN(t) ? 0 : t;
  }
}
