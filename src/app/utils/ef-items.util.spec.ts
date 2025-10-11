import { buildHistoryEfItems, buildLatestEfItems, ExposureGroupRaw } from './ef-items.util';

describe('ef-items.util', () => {
    const baseGroup = (name: string, fractions: number[]): ExposureGroupRaw => ({
        ExposureGroup: name,
        ExceedanceFractionHistory: fractions.map((f, i) => ({
            DateCalculated: new Date(2024, 0, i + 1).toISOString(),
            ExceedanceFraction: f,
            ResultsUsed: [{ Agent: 'X' }]
        }))
    });

    const groupWithSampleDates = (name: string, fractions: number[], sampleDates: string[][]): ExposureGroupRaw => ({
        ExposureGroup: name,
        ExceedanceFractionHistory: fractions.map((f, i) => ({
            DateCalculated: new Date(2024, 0, i + 1).toISOString(),
            ExceedanceFraction: f,
            ResultsUsed: (sampleDates[i] || []).map(d => ({ Agent: 'X', SampleDate: d }))
        }))
    });

    it('buildHistoryEfItems should flatten and compute trend/delta', () => {
        const groups = [baseGroup('G1', [0.01, 0.02, 0.015])];
        const items = buildHistoryEfItems(groups);
        expect(items.length).toBe(3);
        const last = items.find(i => i.DateCalculated === new Date(2024, 0, 3).toISOString());
        expect(last?.Trend).toBe('down');
        expect(last?.Delta).toBeLessThan(0); // 0.015 - 0.02
    });

    it('buildLatestEfItems returns only latest per group with correct trend', () => {
        const groups = [baseGroup('G1', [0.01, 0.02, 0.015])];
        const latest = buildLatestEfItems(groups);
        expect(latest.length).toBe(1);
        expect(latest[0].ExceedanceFraction).toBe(0.015);
        expect(latest[0].Trend).toBe('down');
    });

    it('handles empty input gracefully', () => {
        expect(buildHistoryEfItems([])).toEqual([]);
        expect(buildLatestEfItems([])).toEqual([]);
    });

    it('buildHistoryEfItems computes MostRecentSampleDate correctly', () => {
        const groups = [groupWithSampleDates('G1', [0.01, 0.02], [
            ['2024-01-10T00:00:00.000Z', '2024-01-15T00:00:00.000Z', '2024-01-20T00:00:00.000Z'],
            ['2024-02-01T00:00:00.000Z', '2024-02-05T00:00:00.000Z']
        ])];
        const items = buildHistoryEfItems(groups);
        expect(items.length).toBe(2);
        // First entry should have most recent date from first set
        const first = items.find(i => i.DateCalculated === new Date(2024, 0, 1).toISOString());
        expect(first?.MostRecentSampleDate).toBe('2024-01-20T00:00:00.000Z');
        // Second entry should have most recent date from second set
        const second = items.find(i => i.DateCalculated === new Date(2024, 0, 2).toISOString());
        expect(second?.MostRecentSampleDate).toBe('2024-02-05T00:00:00.000Z');
    });

    it('buildLatestEfItems computes MostRecentSampleDate correctly', () => {
        const groups = [groupWithSampleDates('G1', [0.01, 0.02], [
            ['2024-01-10T00:00:00.000Z', '2024-01-15T00:00:00.000Z'],
            ['2024-02-01T00:00:00.000Z', '2024-02-10T00:00:00.000Z', '2024-02-15T00:00:00.000Z']
        ])];
        const latest = buildLatestEfItems(groups);
        expect(latest.length).toBe(1);
        // Latest should use most recent date from the second (most recent) entry
        expect(latest[0].MostRecentSampleDate).toBe('2024-02-15T00:00:00.000Z');
    });

    it('MostRecentSampleDate handles empty ResultsUsed', () => {
        const groups = [groupWithSampleDates('G1', [0.01], [[]])];
        const items = buildHistoryEfItems(groups);
        expect(items.length).toBe(1);
        expect(items[0].MostRecentSampleDate).toBe('');
    });

    it('MostRecentSampleDate handles missing SampleDate fields', () => {
        const groups: ExposureGroupRaw[] = [{
            ExposureGroup: 'G1',
            ExceedanceFractionHistory: [{
                DateCalculated: new Date(2024, 0, 1).toISOString(),
                ExceedanceFraction: 0.01,
                ResultsUsed: [{ Agent: 'X' }, { Agent: 'Y', SampleDate: '2024-01-10T00:00:00.000Z' }]
            }]
        }];
        const items = buildHistoryEfItems(groups);
        expect(items.length).toBe(1);
        // Should find the one valid date
        expect(items[0].MostRecentSampleDate).toBe('2024-01-10T00:00:00.000Z');
    });
});
