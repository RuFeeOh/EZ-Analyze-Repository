import { ExceedanceFraction } from "./exceedance-fraction.model";
import { ExposureGroupResult } from "./exposure-group-result.model";
import { SampleInfo } from "./sample-info.model";

export class ExposureGroup {
    OrganizationUid: string = "";

    OrganizationName: string = "";
    Group: string = "";
    ExposureGroup: string = "";
    plantName?: string;
    jobName?: string;
    plantKey?: string;
    jobKey?: string;
    plantJobNeedsReview?: boolean;
    LatestExceedanceFraction: ExceedanceFraction | null = null;
    Results: SampleInfo[] = [];
    ExceedanceFractionHistory: ExceedanceFraction[] | null = null;
    constructor(partial: Partial<ExposureGroup>) {
        Object.assign(this, partial);

    }

}