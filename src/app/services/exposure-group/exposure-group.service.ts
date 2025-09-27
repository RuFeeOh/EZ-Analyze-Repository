import { inject, Injectable } from '@angular/core';
import { collection, doc, runTransaction, serverTimestamp, writeBatch, getDocs, query, where, documentId } from 'firebase/firestore';
import { SampleInfo } from '../../models/sample-info.model';
import { Firestore } from '@angular/fire/firestore';
import { ExposureGroup } from '../../models/exposure-group.model';
import { ExceedanceFraction } from '../../models/exceedance-fraction.model';
import { ExceedanceFractionService } from '../exceedance-fraction/exceedance-fraction.service';
import { Auth } from '@angular/fire/auth';


@Injectable({
  providedIn: 'root'
})
export class ExposureGroupService {
  private firestore = inject(Firestore);
  private exceedanceFractionservice = inject(ExceedanceFractionService)
  private auth = inject(Auth);

  constructor() { }

  /**
   * Remove transient UI/validation fields from SampleInfo rows before persisting.
   * Keeps only the known SampleInfo fields.
   */
  private sanitizeRows(rows: SampleInfo[] = []): SampleInfo[] {
    return (rows || []).map((r: any) => {
      // Ensure we never return undefined fields (Firestore forbids undefined values)
      const sampleNumber = r?.SampleNumber;
      const twaRaw = r?.TWA;
      const twa = (twaRaw === '' || twaRaw === undefined || twaRaw === null) ? null : Number(twaRaw);
      return {
        Location: r?.Location ?? "",
        SampleNumber: (sampleNumber === undefined || sampleNumber === '') ? null : sampleNumber,
        SampleDate: r?.SampleDate ?? "",
        ExposureGroup: r?.ExposureGroup ?? "",
        Agent: r?.Agent ?? "",
        TWA: twa,
        Notes: r?.Notes ?? "",
      } as SampleInfo as any;
    });
  }

  // Remove undefined values to satisfy Firestore data constraints
  private stripUndefined<T extends Record<string, any>>(obj: T): T {
    const out: any = {};
    for (const k of Object.keys(obj || {})) {
      const v = (obj as any)[k];
      if (v !== undefined) out[k] = v;
    }
    return out as T;
  }

  async saveSampleInfo(sampleInfo: SampleInfo[], organizationUid: string, organizationName: string) {
    try {
      // Deterministic document ID within org: slug(group)
      const groupName = sampleInfo[0]?.ExposureGroup || 'unknown-group';
      const docId = this.slugify(groupName);
      const colRef = collection(this.firestore, `organizations/${organizationUid}/exposureGroups`);
      const docRef = doc(colRef, docId);

      // Upsert using a transaction to atomically concatenate results
      const uid = this.auth.currentUser?.uid;
      if (!uid) throw new Error('AUTH_REQUIRED');
      await runTransaction(this.firestore, async (tx) => {
        const snap = await tx.get(docRef as any);
        const existingData: any = snap.exists() ? (snap.data() || {}) : {};
        const existingResults: SampleInfo[] = (existingData?.Results ?? []) as SampleInfo[];
        // Sanitize both existing and incoming rows to avoid saving transient fields
        const updatedResults: SampleInfo[] = [
          ...this.sanitizeRows(existingResults),
          ...this.sanitizeRows(sampleInfo),
        ];

        if (!snap.exists()) {
          // Create new document WITHOUT EF fields (server computes them)
          const payload = {
            OrganizationUid: organizationUid,
            OrganizationName: organizationName,
            Group: groupName,
            ExposureGroup: groupName,
            Results: JSON.parse(JSON.stringify(updatedResults)),
            createdAt: serverTimestamp(),
            createdBy: uid,
            updatedAt: serverTimestamp(),
            updatedBy: uid,
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
            updatedAt: serverTimestamp(),
            updatedBy: uid,
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

    const uid = this.auth.currentUser?.uid;
    if (!uid) throw new Error('AUTH_REQUIRED');
    const saved: { id: string, groupName: string }[] = [];

    // 1) Ensure parent docs exist and set Importing flag (batched existence check)
    {
      // Build list of ids and map to names/refs
      const idMap: { id: string; groupName: string; ref: any }[] = entries.map(([groupNameRaw, samples]) => {
        const groupName = groupNameRaw || samples[0]?.ExposureGroup || 'unknown-group';
        const id = this.slugify(groupName);
        const ref = doc(colRef, id);
        return { id, groupName, ref };
      });


      const existing = new Set<string>();
      try {
        const q = query(colRef as any, where(documentId(), 'in', idMap.map(s => s.id)));
        const snap = await getDocs(q as any);
        snap.forEach(d => existing.add(d.id));
      } catch {
        // If a chunk fails (e.g., emulator edge), fall back by marking none existing for this slice
      }

      // Write Importing flag, with created fields only for new docs
      const batch = writeBatch(this.firestore);
      for (const item of idMap) {
        const base: any = {
          OrganizationUid: organizationUid,
          OrganizationName: organizationName,
          Group: item.groupName,
          ExposureGroup: item.groupName,
          Importing: true,
          updatedAt: serverTimestamp(),
          updatedBy: uid,
        };
        const isExisting = existing.has(item.id);
        if (!isExisting) {
          base.createdAt = serverTimestamp();
          base.createdBy = uid;
        }
        batch.set(item.ref as any, base, { merge: true });
        saved.push({ id: item.id, groupName: item.groupName });
      }
      await batch.commit();
    }

    // 2) Write results to subcollections in chunks
    const CHUNK = 300; // rows per batch
    const errors: { group: string; error: string }[] = [];
    for (const [groupNameRaw, samplesRaw] of entries) {
      const groupName = groupNameRaw || samplesRaw[0]?.ExposureGroup || 'unknown-group';
      const docId = this.slugify(groupName);
      const resultsCol = collection(this.firestore, `organizations/${organizationUid}/exposureGroups/${docId}/results`);
      const samples = this.sanitizeRows(samplesRaw);
      for (let i = 0; i < samples.length; i += CHUNK) {
        const batch = writeBatch(this.firestore);
        const end = Math.min(i + CHUNK, samples.length);
        for (let j = i; j < end; j++) {
          const s = samples[j] as any;
          // Use idempotent id: SampleNumber + SampleDate + TWA hash (best-effort)
          const rawId = `${s.SampleNumber || ''}-${s.SampleDate || ''}-${s.TWA || ''}-${j}`.toLowerCase();
          const id = rawId.replace(/[^a-z0-9\-]/g, '').slice(0, 120) || `${Date.now()}-${j}`;
          const docRefInst = doc(resultsCol as any, id);
          const payload = this.stripUndefined({
            ...s,
            Group: groupName,
            ExposureGroup: groupName,
            createdAt: serverTimestamp(),
            createdBy: uid,
            updatedAt: serverTimestamp(),
            updatedBy: uid,
          });
          batch.set(docRefInst as any, payload, { merge: true });
        }
        try {
          await batch.commit();
        } catch (e: any) {
          errors.push({ group: groupName, error: e?.message || String(e) });
        }
      }
    }

    // 3) Clear Importing flag (EF will recompute via subcollection trigger or via callable below)
    {
      const batch = writeBatch(this.firestore);
      for (const s of saved) {
        const docRefInst = doc(colRef, s.id);
        batch.set(docRefInst as any, { Importing: false, updatedAt: serverTimestamp(), updatedBy: uid }, { merge: true });
      }
      await batch.commit();
    }

    if (errors.length) {
      const message = `Some groups failed to upload (${errors.length}). First error: ${errors[0].group}: ${errors[0].error}`;
      const err = new Error(message);
      (err as any).code = 'PARTIAL_UPLOAD_FAILED';
      (err as any).details = errors;
      throw err;
    }
    return saved;
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
        } else if (+(sample.TWA ?? 0) === 0) {
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
