export class ExposureGroupTableItem {
    SampleDate: string = "";
    ExposureGroup: string = "";
    TWA: number = 0;
    Notes: string = "";
    SampleNumber: number = 0;;
    constructor(partial?: Partial<ExposureGroupTableItem>) {
        Object.assign(this, partial);
    }
}