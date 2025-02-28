import { ExceedanceFraction } from "./exceedance-fraction.model";
import { ExposureGroupResult } from "./exposure-group-result.model";

export class ExposureGroup {
    CompanyUid: string = "";

    CompanyName: string = "";
    Group: string = "";
    ExposureGroup: string = "";
    LatestExceedanceFraction: ExceedanceFraction = new ExceedanceFraction();
    Results: ExposureGroupResult[] = [];
    ExceedanceFractionHistory: ExceedanceFraction[] = [];
    constructor(partial: Partial<ExposureGroup>) {
        Object.assign(this, partial);

    }

}