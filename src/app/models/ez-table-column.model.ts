export class EzTableColumn {
    Name: string = "";
    DisplayName: string = "";
    Type: 'string' | 'date' | 'number' = "string";
    constructor(init?: Partial<EzTableColumn>) {
        Object.assign(this, init);
    }
}