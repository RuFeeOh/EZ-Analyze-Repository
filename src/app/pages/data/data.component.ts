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
import { TableComponent } from '../../features/ez-table/table.component';
import { EzTableColumn } from '../../models/ez-table-column.model';
import { MatSnackBar } from '@angular/material/snack-bar';

@Component({
  selector: 'ez-data',
  imports: [
    CommonModule,
    MatIconModule,
    MatButtonModule,
    MatTableModule,
    TableComponent
  ],
  templateUrl: './data.component.html',
  styleUrl: './data.component.scss'
})
export class DataComponent {
  private exceedanceFractionservice = inject(ExceedanceFractionService);
  private exposureGroupservice = inject(ExposureGroupService);
  private organizationservice = inject(OrganizationService);
  private snackBar = inject(MatSnackBar);
  excelData!: SampleInfo[];
  exceedanceFraction!: number;
  public columnsToDisplay: EzTableColumn[] = [
    new EzTableColumn({ Name: 'SampleNumber', DisplayName: 'Sample Number', Type: 'string' }),
    new EzTableColumn({ Name: 'SampleDate', DisplayName: 'Sample Date', Type: 'date' }),
    new EzTableColumn({ Name: 'ExposureGroup', DisplayName: 'Exposure Group', Type: 'string' }),
    new EzTableColumn({ Name: 'TWA', DisplayName: 'TWA', Type: 'number' })
  ];
  onFileChange(event: any) {
    const file = event.target.files[0];
    const fileReader = new FileReader();
    fileReader.onload = (e) => {
      const arrayBuffer: any = fileReader.result;
      const data = new Uint8Array(arrayBuffer);
      const workbook = XLSX.read(data, { type: 'array', cellDates: true }); // Ensure dates are read as dates
      const sheetName = workbook.SheetNames[0];
      this.filterExcelDataForSilica(workbook, sheetName);
      this.calculateExceedanceFraction();
    };
    fileReader.readAsArrayBuffer(file);

  }
  private filterExcelDataForSilica(workbook: XLSX.WorkBook, sheetName: string) {
    const tempData: SampleInfo[] = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    // filter only to iclude where Agent includes "silica, crystalline quartz"
    const filteredData = tempData.filter((row: SampleInfo) => row.Agent?.toLowerCase().includes("silica, crystalline quartz"));
    this.excelData = filteredData;
  }

  calculateExceedanceFraction() {
    //create a variable to separate the ExposureGroup column into an array
    const exposureGroups: {
      [key: string]: SampleInfo[];
    } = this.exposureGroupservice.separateSampleInfoByExposureGroup(this.excelData);
    //calculate the exceedance fraction for each ExposureGroup
    for (const exposureGroupName in exposureGroups) {
      const exposureGroup = exposureGroups[exposureGroupName];
      if (exposureGroup.length === 1) {
        continue;
      }
      const TWAlist: number[] = this.exposureGroupservice.getTWAListFromSampleInfo(exposureGroup);
      const exceedanceFraction = this.exceedanceFractionservice.calculateExceedanceProbability(TWAlist, 0.05);
      console.log(exposureGroupName, "||", exceedanceFraction, "||| length: ", exposureGroup.length);
    }


    const TWAlist: number[] = this.exposureGroupservice.getTWAListFromSampleInfo(this.excelData);
    this.exceedanceFraction = this.exceedanceFractionservice.calculateExceedanceProbability(TWAlist, 0.05);
  }

  async saveSampleInfo() {
    const currentOrg = this.organizationservice.currentOrg();
    if (!currentOrg) {
      throw new Error("No current organization");
    }

    await this.exposureGroupservice.saveSampleInfo(this.excelData, currentOrg.Uid, currentOrg.Name);

    const exposureGroupCount = this.excelData.length; // Assuming excelData contains the exposure groups
    this.snackBar.open(`Saved ${exposureGroupCount} exposureGroups`, 'Close', {
      duration: 3000,
    });
  }
}
