import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EzTableComponent } from './ez-table.component';
import { EzColumn } from '../../models/ez-column.model';

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

  it('should compute visible rows based on paginator slice', () => {
    (component as any).summaryColumns.set(['ExposureGroup']);
    (component as any).items.set([
      { ExposureGroup: 'Group A' },
      { ExposureGroup: 'Group B' },
      { ExposureGroup: 'Group C' }
    ]);
    const paginatorStub = { pageIndex: 1, pageSize: 2 };
    component.paginatorSignal.set(paginatorStub as any);
    fixture.detectChanges();

    const rows = (component as any).getVisibleRows();
    expect(rows.length).toBe(1);
    expect(rows[0].ExposureGroup).toBe('Group C');
  });

  it('should build CSV with escaped values', () => {
    const columns = ['ExposureGroup', new EzColumn({ Name: 'Notes', DisplayName: 'Notes' })];
    const rows = [
      { ExposureGroup: 'Alpha', Notes: 'Line,1' },
      { ExposureGroup: 'Beta', Notes: 'Quote "test"' }
    ];
    const csv = (component as any).buildCsv(columns, rows);
    expect(csv.split('\n')[0]).toBe('ExposureGroup,Notes');
    expect(csv).toContain('"Line,1"');
    expect(csv).toContain('"Quote ""test"""');
  });

  it('should format percent columns when exporting', () => {
    const columns = [new EzColumn({ Name: 'ExceedanceFraction', DisplayName: 'EF', Format: 'percent' })];
    const rows = [{ ExceedanceFraction: 0.245 }];
    const csv = (component as any).buildCsv(columns, rows);
    expect(csv.split('\n')[1]).toBe('24.5%');
  });
});
