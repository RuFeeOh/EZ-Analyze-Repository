import { TestBed } from '@angular/core/testing';

import { ExposureGroupService } from './exposure-group.service';

describe('ExposureGroupService', () => {
  let service: ExposureGroupService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ExposureGroupService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
