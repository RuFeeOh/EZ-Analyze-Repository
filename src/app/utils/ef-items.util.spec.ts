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
});
