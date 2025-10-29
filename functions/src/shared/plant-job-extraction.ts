/**
 * Plant/Job Extraction Utility
 * 
 * This module provides utilities to split exposure group names into plant and job components
 * using heuristics, similarity matching, and a plant dictionary.
 */

import { slugify } from "./common";

export interface PlantJobExtraction {
    plantName: string;
    jobName: string;
    plantKey: string;
    jobKey: string;
    confidence: number;
    plantJobNeedsReview: boolean;
}

export interface PlantDictionaryEntry {
    plantName: string;
    frequency: number;
    variants: Set<string>;
}

export class PlantJobExtractor {
    private plantDictionary: Map<string, PlantDictionaryEntry> = new Map();
    
    // Common stop words that typically separate plant from job
    private readonly stopWords = new Set([
        'at', 'in', 'of', '-', '–', '—', '|', ':', 'the'
    ]);
    
    // Common job-related terms that help identify job components
    private readonly jobTerms = new Set([
        'bagging', 'warehouse', 'production', 'packaging', 'assembly',
        'manufacturing', 'mixing', 'loading', 'processing', 'operator',
        'maintenance', 'shipping', 'receiving', 'office', 'lab', 'laboratory'
    ]);
    
    constructor(existingExposureGroups: string[] = []) {
        this.buildPlantDictionary(existingExposureGroups);
    }
    
    /**
     * Extract plant and job from an exposure group name
     */
    extract(exposureGroupName: string): PlantJobExtraction {
        if (!exposureGroupName || typeof exposureGroupName !== 'string') {
            return this.createFallbackResult('', exposureGroupName || '');
        }
        
        const cleaned = exposureGroupName.trim();
        
        // Try various extraction strategies
        const strategies = [
            () => this.extractWithStopWords(cleaned),
            () => this.extractWithDash(cleaned),
            () => this.extractWithJobTerms(cleaned),
            () => this.extractLastToken(cleaned),
            () => this.extractWithDictionary(cleaned)
        ];
        
        let bestResult: PlantJobExtraction | null = null;
        let highestConfidence = 0;
        
        for (const strategy of strategies) {
            const result = strategy();
            if (result && result.confidence > highestConfidence) {
                bestResult = result;
                highestConfidence = result.confidence;
            }
        }
        
        if (bestResult) {
            return bestResult;
        }
        
        // Fallback: treat entire name as plant
        return this.createFallbackResult(cleaned, '');
    }
    
    /**
     * Extract using stop words as delimiters
     */
    private extractWithStopWords(name: string): PlantJobExtraction | null {
        const lowerName = name.toLowerCase();
        
        for (const stopWord of this.stopWords) {
            const index = lowerName.indexOf(` ${stopWord} `);
            if (index > 0) {
                const plantPart = name.substring(0, index).trim();
                const jobPart = name.substring(index + stopWord.length + 2).trim();
                
                if (plantPart && jobPart) {
                    const confidence = this.calculateConfidence(plantPart, jobPart, 0.75);
                    return this.createResult(plantPart, jobPart, confidence);
                }
            }
        }
        
        return null;
    }
    
    /**
     * Extract using dash/hyphen as delimiter
     */
    private extractWithDash(name: string): PlantJobExtraction | null {
        // Match various dash types
        const dashPattern = /\s*[-–—]\s*/;
        const parts = name.split(dashPattern);
        
        if (parts.length === 2) {
            const [plantPart, jobPart] = parts.map(p => p.trim());
            if (plantPart && jobPart) {
                const confidence = this.calculateConfidence(plantPart, jobPart, 0.85);
                return this.createResult(plantPart, jobPart, confidence);
            }
        }
        
        return null;
    }
    
    /**
     * Extract by identifying job-related terms
     */
    private extractWithJobTerms(name: string): PlantJobExtraction | null {
        const words = name.split(/\s+/);
        const lowerWords = words.map(w => w.toLowerCase());
        
        // Find the first job term
        let jobTermIndex = -1;
        for (let i = 0; i < lowerWords.length; i++) {
            if (this.jobTerms.has(lowerWords[i])) {
                jobTermIndex = i;
                break;
            }
        }
        
        if (jobTermIndex > 0) {
            const plantPart = words.slice(0, jobTermIndex).join(' ').trim();
            const jobPart = words.slice(jobTermIndex).join(' ').trim();
            
            if (plantPart && jobPart) {
                const confidence = this.calculateConfidence(plantPart, jobPart, 0.80);
                return this.createResult(plantPart, jobPart, confidence);
            }
        }
        
        return null;
    }
    
    /**
     * Extract by taking the last token as job
     */
    private extractLastToken(name: string): PlantJobExtraction | null {
        const words = name.split(/\s+/);
        
        if (words.length >= 2) {
            const jobPart = words[words.length - 1].trim();
            const plantPart = words.slice(0, -1).join(' ').trim();
            
            if (plantPart && jobPart) {
                const confidence = this.calculateConfidence(plantPart, jobPart, 0.60);
                return this.createResult(plantPart, jobPart, confidence);
            }
        }
        
        return null;
    }
    
    /**
     * Extract using the plant dictionary for matching
     */
    private extractWithDictionary(name: string): PlantJobExtraction | null {
        if (this.plantDictionary.size === 0) {
            return null;
        }
        
        let bestMatch: { plant: string; similarity: number; jobPart: string } | null = null;
        let highestSimilarity = 0;
        
        for (const [, entry] of this.plantDictionary.entries()) {
            // Check if the name starts with or contains this known plant
            const plantName = entry.plantName;
            const lowerName = name.toLowerCase();
            const lowerPlant = plantName.toLowerCase();
            
            if (lowerName.startsWith(lowerPlant)) {
                const remainder = name.substring(plantName.length).trim();
                const trimmedRemainder = this.trimLeadingStopWords(remainder);
                
                if (trimmedRemainder) {
                    const similarity = 1.0; // exact match
                    if (similarity > highestSimilarity) {
                        highestSimilarity = similarity;
                        bestMatch = { plant: plantName, similarity, jobPart: trimmedRemainder };
                    }
                }
            } else {
                // Check variants
                for (const variant of entry.variants) {
                    if (lowerName.includes(variant.toLowerCase())) {
                        const similarity = this.calculateStringSimilarity(variant, name.substring(0, variant.length));
                        if (similarity > highestSimilarity && similarity > 0.7) {
                            const remainder = name.substring(variant.length).trim();
                            const trimmedRemainder = this.trimLeadingStopWords(remainder);
                            
                            if (trimmedRemainder) {
                                highestSimilarity = similarity;
                                bestMatch = { plant: variant, similarity, jobPart: trimmedRemainder };
                            }
                        }
                    }
                }
            }
        }
        
        if (bestMatch) {
            const confidence = this.calculateConfidence(bestMatch.plant, bestMatch.jobPart, 0.7 + (bestMatch.similarity * 0.2));
            return this.createResult(bestMatch.plant, bestMatch.jobPart, confidence);
        }
        
        return null;
    }
    
    /**
     * Build a dictionary of known plants from existing exposure groups
     */
    private buildPlantDictionary(exposureGroups: string[]): void {
        const plantCounts = new Map<string, { name: string; count: number; variants: Set<string> }>();
        
        for (const group of exposureGroups) {
            if (!group || typeof group !== 'string') continue;
            
            // Try to extract a potential plant name using simple heuristics
            const extraction = this.extractSimple(group);
            if (extraction.plantName) {
                const key = slugify(extraction.plantName);
                
                if (!plantCounts.has(key)) {
                    plantCounts.set(key, {
                        name: extraction.plantName,
                        count: 0,
                        variants: new Set()
                    });
                }
                
                const entry = plantCounts.get(key)!;
                entry.count++;
                entry.variants.add(extraction.plantName);
            }
        }
        
        // Only keep plants that appear multiple times (frequency > 1)
        for (const [key, data] of plantCounts.entries()) {
            if (data.count > 1) {
                this.plantDictionary.set(key, {
                    plantName: data.name,
                    frequency: data.count,
                    variants: data.variants
                });
            }
        }
    }
    
    /**
     * Simple extraction for building dictionary
     */
    private extractSimple(name: string): { plantName: string; jobName: string } {
        // Try dash first
        const dashMatch = name.match(/^([^-–—]+)[-–—](.+)$/);
        if (dashMatch) {
            return { plantName: dashMatch[1].trim(), jobName: dashMatch[2].trim() };
        }
        
        // Try stop words
        for (const stopWord of this.stopWords) {
            const parts = name.split(new RegExp(`\\s+${stopWord}\\s+`, 'i'));
            if (parts.length === 2) {
                return { plantName: parts[0].trim(), jobName: parts[1].trim() };
            }
        }
        
        // Try last token
        const words = name.split(/\s+/);
        if (words.length >= 2) {
            return {
                plantName: words.slice(0, -1).join(' ').trim(),
                jobName: words[words.length - 1].trim()
            };
        }
        
        return { plantName: name, jobName: '' };
    }
    
    /**
     * Trim leading stop words from a string
     */
    private trimLeadingStopWords(str: string): string {
        let result = str.trim();
        
        for (const stopWord of this.stopWords) {
            const pattern = new RegExp(`^${stopWord}\\s+`, 'i');
            result = result.replace(pattern, '').trim();
        }
        
        return result;
    }
    
    /**
     * Calculate confidence score based on various factors
     */
    private calculateConfidence(plantPart: string, jobPart: string, baseConfidence: number): number {
        let confidence = baseConfidence;
        
        // Boost confidence if plant is in dictionary
        const plantKey = slugify(plantPart);
        if (this.plantDictionary.has(plantKey)) {
            confidence = Math.min(1.0, confidence + 0.15);
        }
        
        // Boost confidence if job contains known job terms
        const jobLower = jobPart.toLowerCase();
        for (const term of this.jobTerms) {
            if (jobLower.includes(term)) {
                confidence = Math.min(1.0, confidence + 0.10);
                break;
            }
        }
        
        // Reduce confidence if parts are very short
        if (plantPart.length < 3 || jobPart.length < 3) {
            confidence *= 0.7;
        }
        
        return Math.max(0, Math.min(1, confidence));
    }
    
    /**
     * Calculate string similarity using Jaro-Winkler distance
     */
    private calculateStringSimilarity(s1: string, s2: string): number {
        if (!s1 || !s2) return 0;
        
        const lower1 = s1.toLowerCase();
        const lower2 = s2.toLowerCase();
        
        if (lower1 === lower2) return 1.0;
        
        // Simple Levenshtein-based similarity
        const maxLen = Math.max(s1.length, s2.length);
        const distance = this.levenshteinDistance(lower1, lower2);
        return 1 - (distance / maxLen);
    }
    
    /**
     * Calculate Levenshtein distance between two strings
     */
    private levenshteinDistance(s1: string, s2: string): number {
        const len1 = s1.length;
        const len2 = s2.length;
        const matrix: number[][] = [];
        
        for (let i = 0; i <= len1; i++) {
            matrix[i] = [i];
        }
        
        for (let j = 0; j <= len2; j++) {
            matrix[0][j] = j;
        }
        
        for (let i = 1; i <= len1; i++) {
            for (let j = 1; j <= len2; j++) {
                const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,      // deletion
                    matrix[i][j - 1] + 1,      // insertion
                    matrix[i - 1][j - 1] + cost // substitution
                );
            }
        }
        
        return matrix[len1][len2];
    }
    
    /**
     * Create a result object
     */
    private createResult(plantName: string, jobName: string, confidence: number): PlantJobExtraction {
        // Apply title casing
        const titleCasedPlant = this.toTitleCase(plantName);
        const titleCasedJob = this.toTitleCase(jobName);
        
        return {
            plantName: titleCasedPlant,
            jobName: titleCasedJob,
            plantKey: slugify(titleCasedPlant),
            jobKey: slugify(titleCasedJob),
            confidence,
            plantJobNeedsReview: confidence < 0.7
        };
    }
    
    /**
     * Create a fallback result when extraction fails
     */
    private createFallbackResult(plantName: string, jobName: string): PlantJobExtraction {
        const titleCasedPlant = plantName ? this.toTitleCase(plantName) : '';
        const titleCasedJob = jobName ? this.toTitleCase(jobName) : '';
        
        return {
            plantName: titleCasedPlant,
            jobName: titleCasedJob,
            plantKey: slugify(titleCasedPlant),
            jobKey: slugify(titleCasedJob),
            confidence: plantName && jobName ? 0.5 : 0.3,
            plantJobNeedsReview: true
        };
    }
    
    /**
     * Convert string to title case
     */
    private toTitleCase(str: string): string {
        if (!str) return '';
        
        return str
            .split(/\s+/)
            .map(word => {
                if (word.length === 0) return word;
                return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
            })
            .join(' ');
    }
    
    /**
     * Add a plant to the dictionary (useful for manual corrections)
     */
    addPlantToDictionary(plantName: string, variants: string[] = []): void {
        const key = slugify(plantName);
        const existing = this.plantDictionary.get(key);
        
        if (existing) {
            existing.frequency++;
            variants.forEach(v => existing.variants.add(v));
        } else {
            this.plantDictionary.set(key, {
                plantName,
                frequency: 1,
                variants: new Set([plantName, ...variants])
            });
        }
    }
    
    /**
     * Get the plant dictionary for inspection
     */
    getPlantDictionary(): Map<string, PlantDictionaryEntry> {
        return new Map(this.plantDictionary);
    }
}

/**
 * Convenience function to extract plant/job from a single exposure group name
 */
export function extractPlantJob(
    exposureGroupName: string,
    existingExposureGroups: string[] = []
): PlantJobExtraction {
    const extractor = new PlantJobExtractor(existingExposureGroups);
    return extractor.extract(exposureGroupName);
}
