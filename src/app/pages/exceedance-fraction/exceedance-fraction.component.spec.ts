import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ExceedanceFractionComponent } from './exceedance-fraction.component';

describe('ExceedanceFractionsComponent', () => {
  let component: ExceedanceFractionComponent;
  let fixture: ComponentFixture<ExceedanceFractionComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ExceedanceFractionComponent]
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
