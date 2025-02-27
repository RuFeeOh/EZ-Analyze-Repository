import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import * as XLSX from 'xlsx';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { SampleInfo } from '../../models/sample-info.model';
import { MatTableModule } from '@angular/material/table';


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
  excelData!: SampleInfo[];
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
}
