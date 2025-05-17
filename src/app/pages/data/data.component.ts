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
import { MatSnackBar, MatSnackBarConfig, MatSnackBarRef } from '@angular/material/snack-bar';
import { Organization } from '../../models/organization.model';
import { GroupedExposureGroups } from '../../models/grouped-exposure-groups.model';

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
  private saveMessageRef: MatSnackBarRef<any> | undefined;
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
      this.showNoOrganizationMessage();
      throw new Error("No current organization");
    }
    if (!this.excelData || this.excelData.length === 0) {
      this.showNoDataMessage();
      throw new Error("No data uploaded");
    }
    await this.saveSampleInfoToDB(currentOrg);

  }

  private async saveSampleInfoToDB(currentOrg: Organization) {
    let groupedExposureGroups: GroupedExposureGroups;
    try {
      this.showSaving();
      groupedExposureGroups = await this.exposureGroupservice.saveSampleInfo(this.excelData, currentOrg.Uid, currentOrg.Name);
      this.hideSaving();
      this.saveSampleInfoToDBSuccessResponse(groupedExposureGroups);
    } catch (error) {
      this.saveSampleInfoToDBErrorResponse(error);
      throw new Error(error as string);
    } finally {
      this.hideSaving();
    }
  }

  private saveSampleInfoToDBErrorResponse(error: unknown) {
    console.error("Error saving sample info:", error);
    this.snackBar.open('Error saving data. Please try again.', 'Close', {
      duration: 10000,
    });
  }

  private showSaving() {
    const config: MatSnackBarConfig = {
      duration: 10000,
      panelClass: ['snackbar-saving'],
      horizontalPosition: 'center',
      verticalPosition: 'top',
    }
    this.saveMessageRef = this.snackBar.open('Saving data...', 'Close', config);
  }

  private saveSampleInfoToDBSuccessResponse(groupedExposureGroups: GroupedExposureGroups) {
    const message = this.getSaveSuccessMessage(groupedExposureGroups);
    this.snackBar.open(message, 'Close', {
      duration: 10000,
      panelClass: ['snackbar-success'],
    });
  }

  private hideSaving() {
    // this.saveMessageRef && this.saveMessageRef.dismiss();
  }

  private showNoDataMessage() {
    this.snackBar.open('No data to save. Please upload a file first.', 'Close', {
      duration: 10000,
    });
  }

  private getSaveSuccessMessage(groupedExposureGroups: GroupedExposureGroups) {
    const exposureGroupCount = Object.keys(groupedExposureGroups)?.length || 0; // Assuming excelData contains the exposure groups
    const sampleCount = this.excelData.length;
    const sampleCountText = (sampleCount > 1 ? 'samples' : 'sample');
    const sampleCountMessage = `${sampleCount} ${sampleCountText}`;
    const exposureGroupMessage = `${exposureGroupCount} exposure groups`;
    const message = `${exposureGroupMessage} saved (${sampleCountMessage}).`;
    return message;
  }

  private showNoOrganizationMessage() {
    this.snackBar.open('No current organization. Please select an organization first.', 'Close', {
      duration: 10000,
    });
    throw new Error("No current organization");
  }
}
