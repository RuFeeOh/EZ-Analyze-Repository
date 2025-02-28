import { TestBed } from '@angular/core/testing';

import { ExceedanceFractionService } from './exceedance-fraction.service';

describe('ExceedanceFractionService', () => {
  let service: ExceedanceFractionService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ExceedanceFractionService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
