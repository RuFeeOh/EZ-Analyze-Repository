import { Pipe, PipeTransform } from '@angular/core';
import { EzColumn } from '../models/ez-column.model';

@Pipe({
    name: 'ezFormat',
    standalone: true,
    pure: true,
})
export class EzFormatPipe implements PipeTransform {
    transform(value: any, col: string | EzColumn): string {
        const key = typeof col === 'string' ? col : col?.Name;

        const formatDateDDMMMYYYY = (v: any): string => {
            if (!v) return '';
            const d = new Date(v);
            if (isNaN(d.getTime())) return '';
            const dd = String(d.getDate()).padStart(2, '0');
            const mmm = d.toLocaleString(undefined, { month: 'short' });
            const yyyy = d.getFullYear();
            return `${dd}-${mmm}-${yyyy}`;
        };

        // Auto-format well-known date keys
    if (key === 'SampleDate' || key === 'ExceedanceFractionDate' || key === 'DateCalculated') {
            return formatDateDDMMMYYYY(value);
        }

        const fmt = typeof col === 'string' ? undefined : col?.Format;
        if (fmt === 'percent') {
            const num = typeof value === 'number' ? value : Number(value ?? 0);
            return new Intl.NumberFormat(undefined, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(num);
        }
        if (fmt === 'number') {
            const num = typeof value === 'number' ? value : Number(value ?? 0);
            return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(num);
        }
        if (fmt === 'date') {
            return formatDateDDMMMYYYY(value);
        }

        return (value ?? '').toString();
    }
}
