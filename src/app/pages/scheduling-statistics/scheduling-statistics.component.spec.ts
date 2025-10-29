import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SchedulingStatisticsComponent } from './scheduling-statistics.component';

describe('SchedulingStatisticsComponent', () => {
  let component: SchedulingStatisticsComponent;
  let fixture: ComponentFixture<SchedulingStatisticsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SchedulingStatisticsComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(SchedulingStatisticsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
