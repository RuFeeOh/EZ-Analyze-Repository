export class ExposureGroupResult {
    /**
     * Sample Number is the unique Identifier for Results
     */
    SampleNumber: string = "";
    TimeWeightedAverage: number = 0;
    Date: string = "";
    Notes: string = "";
    DateUploaded: string = new Date().toISOString();
    constructor(partial: Partial<ExposureGroupResult> = {}) {
        Object.assign(this, partial);
    }
}