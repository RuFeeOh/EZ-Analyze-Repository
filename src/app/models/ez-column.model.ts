export class EzColumn {
    Name: string = "";
    DisplayName?: string = "";
    DataType?: 'string' | 'number' | 'boolean' = 'string';
    // Optional display formatting hint (e.g., percent for 0-1 values)
    Format?: 'percent' | 'number' | 'date' | 'text';
    constructor(partial: Partial<EzColumn>) {
        Object.assign(this, partial);
    }
}