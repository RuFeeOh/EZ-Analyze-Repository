import { SampleInfo } from "./sample-info.model";

export class ImportSampleInfo extends SampleInfo {
    ImportJobId: string | null = null;
    constructor(init?: Partial<ImportSampleInfo>) {
        super(init);
        Object.assign(this, init);
    }
}