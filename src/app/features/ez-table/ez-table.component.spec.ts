import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EzTableComponent } from './ez-table.component';

describe('EzTableComponent', () => {
  let component: EzTableComponent;
  let fixture: ComponentFixture<EzTableComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EzTableComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(EzTableComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
