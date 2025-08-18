export class EzColumn {
    Name: string = "";
    DisplayName?: string = "";
    DataType?: 'string' | 'number' | 'boolean' = 'string';
    constructor(partial: Partial<EzColumn>) {
        Object.assign(this, partial);
    }
}