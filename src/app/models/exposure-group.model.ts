import { ExceedanceFraction } from "./exceedance-fraction.model";
import { ExposureGroupResult } from "./exposure-group-result.model";
import { SampleInfo } from "./sample-info.model";

export class ExposureGroup {
    OrganizationUid: string = "";

    OrganizationName: string = "";
    Group: string = "";
    ExposureGroup: string = "";
    LatestExceedanceFraction: ExceedanceFraction = new ExceedanceFraction();
    Results: SampleInfo[] = [];
    ExceedanceFractionHistory: ExceedanceFraction[] = [];
    constructor(partial: Partial<ExposureGroup>) {
        Object.assign(this, partial);

    }

}