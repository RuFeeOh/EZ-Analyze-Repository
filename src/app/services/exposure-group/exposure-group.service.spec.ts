import { TestBed } from '@angular/core/testing';
import { ExposureGroupService } from './exposure-group.service';
import { Firestore } from '@angular/fire/firestore';
import { ExceedanceFractionService } from '../exceedance-fraction/exceedance-fraction.service';
import { SampleInfo } from '../../models/sample-info.model';

function makeSample(n: number, dateISO: string, group: string, twa: number): SampleInfo {
  return { SampleNumber: n, SampleDate: dateISO, ExposureGroup: group, Agent: '', TWA: twa, Notes: '' } as SampleInfo;
}

describe('ExposureGroupService', () => {
  let service: ExposureGroupService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ExposureGroupService,
        { provide: Firestore, useValue: {} },
        { provide: ExceedanceFractionService, useValue: { calculateExceedanceProbability: (arr: number[]) => 0.123 } },
      ]
    });
    service = TestBed.inject(ExposureGroupService);
    spyOn(window, 'alert').and.stub();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('getMostRecentSamples picks last 6 by SampleDate and ignores TWA <= 0', () => {
    const base = new Date('2025-01-01T00:00:00.000Z').getTime();
    const rows: SampleInfo[] = [
      makeSample(1, new Date(base + 0 * 86400000).toISOString(), 'G', 0.2),
      makeSample(2, new Date(base + 1 * 86400000).toISOString(), 'G', 0.3),
      makeSample(3, new Date(base + 2 * 86400000).toISOString(), 'G', 0), // ignored
      makeSample(4, new Date(base + 3 * 86400000).toISOString(), 'G', 0.4),
      makeSample(5, new Date(base + 4 * 86400000).toISOString(), 'G', 0.5),
      makeSample(6, new Date(base + 5 * 86400000).toISOString(), 'G', 0.6),
      makeSample(7, new Date(base + 6 * 86400000).toISOString(), 'G', 0.7),
      makeSample(8, new Date(base + 7 * 86400000).toISOString(), 'G', 0.8),
    ];
    const picked = (service as any).getMostRecentSamples(rows, 6) as SampleInfo[];
    expect(picked.length).toBe(6);
    const sampleNumbers = picked.map(s => s.SampleNumber);
    expect(sampleNumbers).toEqual([8, 7, 6, 5, 4, 2]);
  });

  it('getTWAListFromSampleInfo filters out non-positive values', () => {
    const rows: SampleInfo[] = [
      makeSample(1, new Date().toISOString(), 'G', 0),
      makeSample(2, new Date().toISOString(), 'G', 0.1),
      makeSample(3, new Date().toISOString(), 'G', -1 as any),
      makeSample(4, new Date().toISOString(), 'G', 0.2),
    ];
    const list = service.getTWAListFromSampleInfo(rows);
    expect(list).toEqual([0.1, 0.2]);
  });
});
