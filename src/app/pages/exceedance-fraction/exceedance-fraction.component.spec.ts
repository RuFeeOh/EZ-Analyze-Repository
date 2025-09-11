import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ExceedanceFractionComponent } from './exceedance-fraction.component';
import { commonTestProviders } from '../../../test/test-providers';

// TODO: Re-enable after introducing a Firestore abstraction for easier mocking.
xdescribe('ExceedanceFractionsComponent (skipped pending Firestore mock)', () => {
  let component: ExceedanceFractionComponent;
  let fixture: ComponentFixture<ExceedanceFractionComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ExceedanceFractionComponent],
      providers: [...commonTestProviders]
    })
      .compileComponents();

    fixture = TestBed.createComponent(ExceedanceFractionComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
