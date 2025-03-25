import { ComponentFixture, TestBed } from '@angular/core/testing';

import { OrganizationSelectorComponent } from '../../services/organization/organization.service.spec';

describe('OrganizationSelectorComponent', () => {
  let component: OrganizationSelectorComponent;
  let fixture: ComponentFixture<OrganizationSelectorComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [OrganizationSelectorComponent]
    })
      .compileComponents();

    fixture = TestBed.createComponent(OrganizationSelectorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
