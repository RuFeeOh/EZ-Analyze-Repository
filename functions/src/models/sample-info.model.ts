export class SampleInfo {
    SampleDate!: string;
    ExposureGroup!: string;
    Group!: string;
    TWA!: number | string;
    Notes!: string;
    SampleNumber!: string;
    Agent!: string;
    AgentKey!: string;
    constructor(init?: Partial<SampleInfo>) {
        Object.assign(this, init);
    }
};