export class Agent {
    Name: string = '';
    OELNumber: number = 0.05;
    constructor(init?: Partial<Agent>) {
        Object.assign(this, init);
    }
}
