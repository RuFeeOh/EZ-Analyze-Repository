# Plant/Job Extraction Feature

This document describes the plant/job extraction feature for exposure groups in EZAnalyze.

## Overview

The plant/job extraction feature automatically splits exposure group names into structured plant and job components. This allows for better organization, filtering, and analysis of exposure data across different plants and job types.

## Data Model

Each exposure group now includes the following additional fields:

| Field | Type | Description |
|-------|------|-------------|
| `plantName` | string | The extracted plant name (title-cased) |
| `jobName` | string | The extracted job name (title-cased) |
| `plantKey` | string | Normalized plant key for filtering (slugified) |
| `jobKey` | string | Normalized job key for filtering (slugified) |
| `plantJobNeedsReview` | boolean | Flag indicating low confidence extraction that may need manual review |

These fields are also propagated to:
- `EfSummary` entries in organization documents
- All related statistics and reporting views

## Extraction Logic

The extraction utility uses multiple strategies to split exposure group names:

### 1. Dash/Hyphen Separation
Exposure groups like `"Fort Smith - Bagging"` are split at the dash:
- Plant: `Fort Smith`
- Job: `Bagging`

### 2. Stop Word Separation
Groups using stop words like `"at"`, `"in"`, `"of"` are split accordingly:
- `"Houston Plant at Packaging"` → Plant: `Houston Plant`, Job: `Packaging`

### 3. Job Term Detection
Common job terms (bagging, warehouse, production, etc.) are detected:
- `"Portland Warehouse Operations"` → Plant: `Portland`, Job: `Warehouse Operations`

### 4. Last Token Split
If no other pattern matches, the last word is treated as the job:
- `"Miami Facility Loading"` → Plant: `Miami Facility`, Job: `Loading`

### 5. Plant Dictionary Matching
A dictionary is built from existing exposure groups in the organization. Plants appearing multiple times are recognized for better extraction accuracy.

## Confidence Scoring

Each extraction receives a confidence score (0-1):

- **High confidence (≥0.7)**: Clear separators or known patterns
  - `plantJobNeedsReview = false`
  
- **Low confidence (<0.7)**: Ambiguous patterns or very short names
  - `plantJobNeedsReview = true`
  - These entries are flagged for manual review

Confidence is boosted when:
- The plant name exists in the organization's plant dictionary
- The job name contains known job terms (warehouse, bagging, etc.)

## Automatic Integration

### Import Pipeline

All new imports automatically extract plant/job data:

1. When processing exposure groups via `bulkImportResults`, the system:
   - Loads existing exposure group names to build a plant dictionary
   - Extracts plant/job for each incoming group
   - Stores the structured data alongside the exposure group
   - Propagates to EfSummary entries

2. The extraction is performed once during import and persisted

### UI Display

The plant and job fields are displayed in:

- **Scheduling Statistics page**: Shows plant and job as separate columns
- **Exposure Groups page**: Shows plant and job columns for easy filtering
- All statistics and reporting views that use EfSummary data

## Backfill Process

To apply plant/job extraction to existing exposure groups, use the backfill Cloud Function.

### Running the Backfill

```typescript
// In Firebase Console or using Firebase Admin SDK
const result = await functions.httpsCallable('backfillPlantJobData')({
  orgId: 'your-org-id',
  dryRun: true  // Set to false to actually update data
});
```

### Backfill Options

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `orgId` | string | Yes | The organization ID to process |
| `groupIds` | string[] | No | Specific group IDs to process (default: all groups) |
| `dryRun` | boolean | No | If true, simulates the backfill without making changes |

### Backfill Response

```typescript
{
  ok: boolean,                  // Whether the backfill completed without errors
  dryRun: boolean,              // Whether this was a dry run
  totalGroups: number,          // Total groups in the organization
  processedCount: number,       // Groups successfully processed
  updatedCount: number,         // Groups that were updated
  skippedCount: number,         // Groups skipped (no name, etc.)
  flaggedForReviewCount: number,// Groups with low confidence extraction
  errorCount: number,           // Number of errors encountered
  errors: string[],             // First 10 error messages
  message: string               // Summary message
}
```

### Checking Backfill Status

```typescript
const status = await functions.httpsCallable('getPlantJobBackfillStatus')({
  orgId: 'your-org-id'
});
```

Returns the status of the most recent backfill run, including:
- Completion timestamp
- Counts of processed/updated/flagged groups
- Error information

### Listing Groups Flagged for Review

```typescript
const reviewList = await functions.httpsCallable('listPlantJobReviewCandidates')({
  orgId: 'your-org-id',
  limit: 100  // Optional, max 500
});
```

Returns exposure groups where `plantJobNeedsReview = true`.

## Manual Review and Correction

For groups flagged for review (`plantJobNeedsReview = true`):

1. **Review the extraction**: Check if plant and job names are correct
2. **Update manually if needed**: 
   - Use Firestore console or admin tools
   - Update `plantName`, `jobName`, `plantKey`, `jobKey`
   - Set `plantJobNeedsReview = false` after review
3. **Update the plant dictionary**: High-quality manual corrections help improve future extractions

## Example Extractions

| Exposure Group Name | Plant Name | Job Name | Confidence | Needs Review |
|---------------------|------------|----------|------------|--------------|
| Fort Smith - Bagging | Fort Smith | Bagging | 0.85 | No |
| Houston Plant at Packaging | Houston Plant | Packaging | 0.75 | No |
| Portland Warehouse Operations | Portland | Warehouse Operations | 0.80 | No |
| Miami Facility Loading | Miami Facility | Loading | 0.60 | Yes |
| AB | AB | | 0.30 | Yes |

## Best Practices

### For Administrators

1. **Run backfill in dry-run mode first** to preview changes
2. **Review flagged entries** before considering the backfill complete
3. **Monitor extraction quality** over time and adjust plant dictionary as needed
4. **Standardize naming conventions** for new exposure groups to improve extraction accuracy

### For Users Creating Exposure Groups

Use consistent naming patterns:
- **Recommended**: `"Plant Name - Job Name"` (e.g., `"Fort Smith - Bagging"`)
- **Also good**: `"Plant Name at Job Name"` or `"Plant Name Job Name"`
- **Avoid**: Very short names, abbreviations without context

Common job terms that improve extraction:
- Bagging, Warehouse, Production, Packaging, Assembly
- Manufacturing, Mixing, Loading, Processing, Operator
- Maintenance, Shipping, Receiving, Office, Lab/Laboratory

## Technical Details

### Files Added/Modified

**Backend (Cloud Functions)**:
- `functions/src/shared/plant-job-extraction.ts` - Core extraction utility
- `functions/src/shared/plant-job-backfill.ts` - Backfill Cloud Functions
- `functions/src/shared/import.ts` - Integration into import pipeline
- `functions/src/shared/__tests__/plant-job-extraction.test.ts` - Unit tests

**Frontend (Angular)**:
- `src/app/models/exposure-group.model.ts` - Added plant/job fields
- `src/app/models/exceedance-fraction-summary.model.ts` - Added plant/job fields
- `src/app/pages/scheduling-statistics/scheduling-statistics.component.ts` - Display plant/job
- `src/app/pages/exposure-groups/exposure-groups.component.html` - Display plant/job

### Database Schema

**Firestore Collections**:

```
organizations/{orgId}/exposureGroups/{groupId}
  - ExposureGroup: string
  - plantName: string
  - jobName: string
  - plantKey: string
  - jobKey: string
  - plantJobNeedsReview: boolean
  - [other existing fields...]

organizations/{orgId}
  - EfSummary: {
      [groupId]: {
        - ExposureGroup: string
        - plantName: string
        - jobName: string
        - plantKey: string
        - jobKey: string
        - plantJobNeedsReview: boolean
        - [other EF data...]
      }
    }

organizations/{orgId}/plantJobBackfillStatus/latest
  - completedAt: Timestamp
  - completedBy: string
  - totalGroups: number
  - processedCount: number
  - updatedCount: number
  - skippedCount: number
  - flaggedForReviewCount: number
  - errorCount: number
  - errors: string[]
```

### Performance Considerations

- **Import pipeline**: Negligible overhead (<50ms per exposure group)
- **Backfill**: Processes ~10-50 groups per second depending on Firestore throttling
- **Firestore costs**: Backfill performs 1 read + 1 write per group, plus 1 read for plant dictionary + 1 write for org summary

### Future Enhancements

Potential improvements for future versions:

1. **Machine learning**: Train a model on manually-corrected extractions
2. **User interface for corrections**: Add a review UI in the application
3. **Bulk corrections**: Allow admins to correct multiple groups at once
4. **Plant/job hierarchy**: Support for sites, departments, and other organizational levels
5. **Export/import**: Allow sharing plant dictionaries between organizations

## Support

For issues or questions about the plant/job extraction feature, please:

1. Check the flagged groups using `listPlantJobReviewCandidates`
2. Review the extraction confidence scores
3. Contact support with specific exposure group names that aren't extracting correctly

## Version History

- **1.0.0** (2025): Initial implementation
  - Basic extraction with 5 strategies
  - Plant dictionary with frequency tracking
  - Confidence scoring and review flags
  - Integration into import pipeline
  - Backfill Cloud Functions
  - UI display in scheduling statistics and exposure groups
