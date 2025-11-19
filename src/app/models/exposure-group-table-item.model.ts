export class ExposureGroupTableItem {
    SampleDate: string = "";
    ExposureGroup: string = "";
    TWA: number = 0;
    Notes: string = "";
    SampleNumber: string = "";
    constructor(partial?: Partial<ExposureGroupTableItem>) {
        Object.assign(this, partial);
    }
}