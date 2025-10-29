/**
 * Unit tests for Plant/Job Extraction Utility
 */

import { PlantJobExtractor, extractPlantJob } from '../plant-job-extraction';

describe('PlantJobExtractor', () => {
    describe('extractWithDash', () => {
        it('should extract plant and job separated by dash', () => {
            const extractor = new PlantJobExtractor();
            const result = extractor.extract('Fort Smith - Bagging');
            
            expect(result.plantName).toBe('Fort Smith');
            expect(result.jobName).toBe('Bagging');
            expect(result.plantKey).toBe('fort-smith');
            expect(result.jobKey).toBe('bagging');
            expect(result.confidence).toBeGreaterThan(0.7);
        });
        
        it('should handle different dash types', () => {
            const extractor = new PlantJobExtractor();
            
            const result1 = extractor.extract('Dallas Plant - Production');
            expect(result1.plantName).toBe('Dallas Plant');
            expect(result1.jobName).toBe('Production');
            
            const result2 = extractor.extract('Chicago – Warehouse');
            expect(result2.plantName).toBe('Chicago');
            expect(result2.jobName).toBe('Warehouse');
            
            const result3 = extractor.extract('Phoenix — Assembly');
            expect(result3.plantName).toBe('Phoenix');
            expect(result3.jobName).toBe('Assembly');
        });
    });
    
    describe('extractWithStopWords', () => {
        it('should extract plant and job separated by stop words', () => {
            const extractor = new PlantJobExtractor();
            
            const result1 = extractor.extract('Houston Plant at Packaging');
            expect(result1.plantName).toBe('Houston Plant');
            expect(result1.jobName).toBe('Packaging');
            
            const result2 = extractor.extract('Seattle Facility in Maintenance');
            expect(result2.plantName).toBe('Seattle Facility');
            expect(result2.jobName).toBe('Maintenance');
        });
    });
    
    describe('extractWithJobTerms', () => {
        it('should identify common job terms', () => {
            const extractor = new PlantJobExtractor();
            
            const result1 = extractor.extract('Portland Warehouse Operations');
            expect(result1.plantName).toBe('Portland');
            expect(result1.jobName).toBe('Warehouse Operations');
            expect(result1.confidence).toBeGreaterThan(0.7);
            
            const result2 = extractor.extract('Denver Manufacturing Line 1');
            expect(result2.plantName).toBe('Denver');
            expect(result2.jobName).toBe('Manufacturing Line 1');
        });
    });
    
    describe('extractLastToken', () => {
        it('should use last token as job when no other delimiter found', () => {
            const extractor = new PlantJobExtractor();
            const result = extractor.extract('Miami Facility Loading');
            
            expect(result.plantName).toBe('Miami Facility');
            expect(result.jobName).toBe('Loading');
        });
    });
    
    describe('complex names', () => {
        it('should handle multi-word plants and jobs', () => {
            const extractor = new PlantJobExtractor();
            
            const result = extractor.extract('Fort Smith Industrial Complex - Line 2 Bagging');
            expect(result.plantName).toBe('Fort Smith Industrial Complex');
            expect(result.jobName).toBe('Line 2 Bagging');
        });
        
        it('should handle names with abbreviations', () => {
            const extractor = new PlantJobExtractor();
            
            const result = extractor.extract('LA Plant - Pkg Dept');
            expect(result.plantName).toBe('La Plant');
            expect(result.jobName).toBe('Pkg Dept');
        });
    });
    
    describe('edge cases', () => {
        it('should handle empty strings', () => {
            const extractor = new PlantJobExtractor();
            const result = extractor.extract('');
            
            expect(result.plantName).toBe('');
            expect(result.jobName).toBe('');
            expect(result.plantJobNeedsReview).toBe(true);
        });
        
        it('should handle single word names', () => {
            const extractor = new PlantJobExtractor();
            const result = extractor.extract('Manufacturing');
            
            expect(result.plantName).toBe('Manufacturing');
            expect(result.jobName).toBe('');
            expect(result.plantJobNeedsReview).toBe(true);
        });
        
        it('should handle null/undefined input', () => {
            const extractor = new PlantJobExtractor();
            const result1 = extractor.extract(null as any);
            const result2 = extractor.extract(undefined as any);
            
            expect(result1.plantJobNeedsReview).toBe(true);
            expect(result2.plantJobNeedsReview).toBe(true);
        });
    });
    
    describe('confidence scoring', () => {
        it('should have high confidence for clear separators', () => {
            const extractor = new PlantJobExtractor();
            const result = extractor.extract('Boston Plant - Production Line');
            
            expect(result.confidence).toBeGreaterThan(0.8);
            expect(result.plantJobNeedsReview).toBe(false);
        });
        
        it('should flag ambiguous cases for review', () => {
            const extractor = new PlantJobExtractor();
            const result = extractor.extract('AB');
            
            expect(result.confidence).toBeLessThan(0.7);
            expect(result.plantJobNeedsReview).toBe(true);
        });
    });
    
    describe('plant dictionary', () => {
        it('should build dictionary from existing exposure groups', () => {
            const existingGroups = [
                'Fort Smith - Bagging',
                'Fort Smith - Packaging',
                'Fort Smith - Loading',
                'Dallas Plant - Assembly',
                'Dallas Plant - Testing'
            ];
            
            const extractor = new PlantJobExtractor(existingGroups);
            const dictionary = extractor.getPlantDictionary();
            
            expect(dictionary.has('fort-smith')).toBe(true);
            expect(dictionary.has('dallas-plant')).toBe(true);
            expect(dictionary.get('fort-smith')?.frequency).toBe(3);
        });
        
        it('should use dictionary for improved matching', () => {
            const existingGroups = [
                'Fort Smith Plant - Bagging',
                'Fort Smith Plant - Packaging',
                'Fort Smith - Loading'
            ];
            
            const extractor = new PlantJobExtractor(existingGroups);
            const result = extractor.extract('Fort Smith - Warehouse');
            
            // Should recognize Fort Smith as a known plant
            expect(result.plantName).toContain('Fort Smith');
            expect(result.confidence).toBeGreaterThan(0.8);
        });
        
        it('should not include single-occurrence plants in dictionary', () => {
            const existingGroups = [
                'Phoenix - Production',
                'Fort Smith - Bagging',
                'Fort Smith - Loading'
            ];
            
            const extractor = new PlantJobExtractor(existingGroups);
            const dictionary = extractor.getPlantDictionary();
            
            // Phoenix only appears once, shouldn't be in dictionary
            expect(dictionary.has('phoenix')).toBe(false);
            // Fort Smith appears twice, should be in dictionary
            expect(dictionary.has('fort-smith')).toBe(true);
        });
    });
    
    describe('title casing', () => {
        it('should apply title casing to results', () => {
            const extractor = new PlantJobExtractor();
            
            const result1 = extractor.extract('FORT SMITH - BAGGING');
            expect(result1.plantName).toBe('Fort Smith');
            expect(result1.jobName).toBe('Bagging');
            
            const result2 = extractor.extract('fort smith - bagging');
            expect(result2.plantName).toBe('Fort Smith');
            expect(result2.jobName).toBe('Bagging');
        });
    });
    
    describe('extractPlantJob convenience function', () => {
        it('should work without existing groups', () => {
            const result = extractPlantJob('Seattle - Manufacturing');
            
            expect(result.plantName).toBe('Seattle');
            expect(result.jobName).toBe('Manufacturing');
        });
        
        it('should work with existing groups', () => {
            const existingGroups = [
                'Seattle Facility - Warehouse',
                'Seattle Facility - Shipping'
            ];
            
            const result = extractPlantJob('Seattle Facility - Production', existingGroups);
            
            expect(result.plantName).toBe('Seattle Facility');
            expect(result.jobName).toBe('Production');
            expect(result.confidence).toBeGreaterThan(0.8);
        });
    });
    
    describe('manual dictionary updates', () => {
        it('should allow adding plants to dictionary', () => {
            const extractor = new PlantJobExtractor();
            
            extractor.addPlantToDictionary('Custom Plant', ['Custom Facility', 'Custom Site']);
            const dictionary = extractor.getPlantDictionary();
            
            expect(dictionary.has('custom-plant')).toBe(true);
            expect(dictionary.get('custom-plant')?.variants.has('Custom Plant')).toBe(true);
            expect(dictionary.get('custom-plant')?.variants.has('Custom Facility')).toBe(true);
        });
    });
    
    describe('real-world examples', () => {
        it('should handle various real-world formats', () => {
            const extractor = new PlantJobExtractor();
            
            const testCases = [
                { input: 'Fort Smith - Bagging', expectedPlant: 'Fort Smith', expectedJob: 'Bagging' },
                { input: 'Houston Refinery Production', expectedPlant: 'Houston Refinery', expectedJob: 'Production' },
                { input: 'Chicago Plant at Packaging Line 2', expectedPlant: 'Chicago Plant', expectedJob: 'Packaging Line 2' },
                { input: 'Phoenix Warehouse', expectedPlant: 'Phoenix', expectedJob: 'Warehouse' },
                { input: 'Denver Manufacturing Complex - Assembly Area', expectedPlant: 'Denver Manufacturing Complex', expectedJob: 'Assembly Area' }
            ];
            
            for (const testCase of testCases) {
                const result = extractor.extract(testCase.input);
                expect(result.plantName).toBe(testCase.expectedPlant);
                expect(result.jobName).toBe(testCase.expectedJob);
            }
        });
    });
});
