export class EzColumn {
    Name: string = "";
    DisplayName?: string = "";
    DataType?: 'string' | 'number' | 'boolean' = 'string';
    // Optional display formatting hint
    // - percent-badge renders a colored chip based on thresholds
    // - trend renders an up/down/flat icon based on a string value: 'up' | 'down' | 'flat'
    Format?: 'percent' | 'number' | 'date' | 'text' | 'percent-badge' | 'trend';
    constructor(partial: Partial<EzColumn>) {
        Object.assign(this, partial);
    }
}