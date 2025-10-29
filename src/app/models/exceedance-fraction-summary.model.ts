export class ExceedanceFractionSummary {

    GroupId: string = ""
    ExposureGroup: string = ""
    plantName?: string
    jobName?: string
    plantKey?: string
    jobKey?: string
    plantJobNeedsReview?: boolean
    ExceedanceFraction: number = 0
    PrevExceedanceFraction: number = 0
    Agent: string = ""
    OELNumber: string = ""
    DateCalculated: string = ""
    SamplesUsedCount: number = 0
    constructor(partial: Partial<ExceedanceFractionSummary> = {}) {
        Object.assign(this, partial);
    }
}