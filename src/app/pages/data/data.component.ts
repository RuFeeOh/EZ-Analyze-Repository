import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import * as XLSX from 'xlsx';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { SampleInfo } from '../../models/sample-info.model';
import { MatTableModule } from '@angular/material/table';
import { ExceedanceFractionService } from '../../services/exceedance-fraction/exceedance-fraction.service';
import { ExposureGroupService } from '../../services/exposure-group/exposure-group.service';
import { OrganizationService } from '../../services/organization/organization.service';

@Component({
  selector: 'app-data',
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatTableModule,

  ],
  templateUrl: './data.component.html',
  styleUrl: './data.component.scss'
})
export class DataComponent {
  exceedanceFractionservice = inject(ExceedanceFractionService)
  exposureGroupservice = inject(ExposureGroupService)
  organizationservice = inject(OrganizationService)
  excelData!: SampleInfo[];
  exceedanceFraction!: number;
  columnsToDisplay = ['SampleNumber', 'SampleDate', 'ExposureGroup', 'TWA'];
  columnsToDisplayWithExpand = [...this.columnsToDisplay, 'expand'];
  expandedElement!: SampleInfo | null;
  isExpanded(element: SampleInfo) {
    return this.expandedElement === element;
  }
  toggle(element: SampleInfo) {
    this.expandedElement = this.isExpanded(element) ? null : element;
  }
  onFileChange(event: any) {
    const file = event.target.files[0];
    const fileReader = new FileReader();
    fileReader.onload = (e) => {
      const arrayBuffer: any = fileReader.result;
      const data = new Uint8Array(arrayBuffer);
      const workbook = XLSX.read(data, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      this.excelData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    };
    fileReader.readAsArrayBuffer(file);
  }
  calculateExceedanceFraction() {
    const TWAlist: number[] = [];
    this.excelData
      //.filter(sample => sample.ExposureGroup === "TROUP MINING EQUIPMENT OPERATOR")
      .forEach((sample) => {
        if (sample.TWA && +sample.TWA > 0) {
          TWAlist.push(+sample.TWA)
        } else if (+sample.TWA === 0) {
          // throw new Error('Data contains zeros')
          alert('Data contains zeros')
        }

      })

    console.log(TWAlist);
    this.exceedanceFraction = this.exceedanceFractionservice.calculateExceedanceProbability(TWAlist, 0.05);
  }
  saveSampleInfo() {
    const currentOrg = this.organizationservice.currentOrg;
    if (!currentOrg) { throw new Error("No current organization") }
    this.exposureGroupservice.saveSampleInfo(this.excelData, currentOrg.id, currentOrg.Name);
  }
}
