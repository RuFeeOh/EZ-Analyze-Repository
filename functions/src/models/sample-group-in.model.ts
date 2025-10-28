import { IncomingSampleInfo } from "./incoming-sample-info.model";

export type SampleGroupIn = {
    groupName: string;
    samples: IncomingSampleInfo[]
};