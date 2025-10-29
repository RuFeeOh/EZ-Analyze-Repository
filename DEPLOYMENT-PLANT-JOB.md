# Plant/Job Extraction Feature - Deployment Runbook

This runbook provides step-by-step instructions for deploying the plant/job extraction feature to production.

## Pre-Deployment Checklist

- [ ] Code has been reviewed and approved
- [ ] Unit tests pass locally
- [ ] Functions build successfully (`cd functions && npm run build`)
- [ ] Angular app builds successfully (`ng build`)
- [ ] Feature has been tested in development/emulators
- [ ] Backup plan is in place

## Deployment Steps

### 1. Deploy Cloud Functions (Backend)

```bash
# Navigate to the repository root
cd /path/to/EZ-Analyze-Repository

# Build the functions
cd functions
npm run build

# Deploy to Firebase (production)
firebase deploy --only functions

# Or deploy specific functions
firebase deploy --only functions:bulkImportResults,functions:backfillPlantJobData,functions:getPlantJobBackfillStatus,functions:listPlantJobReviewCandidates
```

**Expected Output:**
- All functions deploy successfully
- No errors in the deployment log
- Functions are accessible via Firebase Console

**Deployment Time:** 2-5 minutes

### 2. Deploy Angular Application (Frontend)

```bash
# From repository root
ng build --configuration production

# Deploy to Firebase Hosting
firebase deploy --only hosting
```

**Expected Output:**
- Build completes without errors
- Static files are uploaded to Firebase Hosting
- Application is accessible at your domain

**Deployment Time:** 2-5 minutes

### 3. Run Backfill (Production Data)

⚠️ **IMPORTANT:** Test the backfill on a single organization first!

#### 3.1. Test on One Organization (Dry Run)

```javascript
// In Firebase Console > Functions > backfillPlantJobData > Test
// Or using Firebase Admin SDK / callable from your app

{
  "orgId": "test-org-id",
  "dryRun": true
}
```

Review the response:
- Check `flaggedForReviewCount` - how many need manual review
- Check `errorCount` - should be 0
- Review error messages if any
- Verify `message` indicates expected behavior

#### 3.2. Run Actual Backfill on Test Org

```javascript
{
  "orgId": "test-org-id",
  "dryRun": false
}
```

**Verify:**
1. Check a few exposure groups in Firestore Console
2. Verify `plantName`, `jobName`, `plantKey`, `jobKey` fields are populated
3. Check `plantJobNeedsReview` flags
4. Verify `organizations/{orgId}/plantJobBackfillStatus/latest` document exists

#### 3.3. Run Backfill on All Organizations

**Option A: Using Firebase Console**

For each organization:
1. Go to Firebase Console > Functions
2. Select `backfillPlantJobData`
3. Click "Test"
4. Enter payload: `{ "orgId": "org-id-here", "dryRun": false }`
5. Review results

**Option B: Using a Script (Recommended for Many Orgs)**

Create a Node.js script:

```javascript
const admin = require('firebase-admin');
const functions = require('firebase-functions-test')();

admin.initializeApp();
const db = admin.firestore();

async function backfillAllOrgs() {
  // Get all organizations
  const orgsSnapshot = await db.collection('organizations').get();
  
  for (const orgDoc of orgsSnapshot.docs) {
    const orgId = orgDoc.id;
    console.log(`Processing org: ${orgId}`);
    
    try {
      // Call the backfill function
      const result = await admin.functions().httpsCallable('backfillPlantJobData')({
        orgId,
        dryRun: false
      });
      
      console.log(`  Success: ${result.data.updatedCount} updated, ${result.data.flaggedForReviewCount} flagged`);
    } catch (error) {
      console.error(`  Error: ${error.message}`);
    }
    
    // Add delay to avoid overwhelming Firestore
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('Backfill complete!');
}

backfillAllOrgs();
```

Run with:
```bash
node scripts/backfill-all-orgs.js
```

### 4. Verify Deployment

#### 4.1. Check Cloud Functions

1. Go to Firebase Console > Functions
2. Verify all functions are deployed and healthy
3. Check for any errors in function logs

#### 4.2. Check Application

1. Open the application in a browser
2. Navigate to Scheduling Statistics page
3. Verify plant and job columns appear
4. Verify data is populated
5. Navigate to Exposure Groups page
6. Verify plant and job columns appear

#### 4.3. Check Firestore Data

1. Open Firestore Console
2. Select an organization
3. Check `exposureGroups` collection
4. Verify fields are present:
   - `plantName`
   - `jobName`
   - `plantKey`
   - `jobKey`
   - `plantJobNeedsReview`
5. Check organization document
6. Verify `EfSummary` entries have plant/job fields

### 5. Monitor Post-Deployment

Monitor for the first 24-48 hours:

#### Metrics to Watch

1. **Function Errors:**
   - Check Cloud Functions logs for errors
   - Especially `bulkImportResults` function

2. **Import Performance:**
   - Monitor import times
   - Should be negligibly impacted (<50ms overhead)

3. **User Reports:**
   - Check for any reports of missing data
   - Check for reports of incorrect extractions

4. **Firestore Usage:**
   - Monitor read/write operations
   - Should not significantly increase

#### Key Logs to Monitor

```bash
# View recent logs
firebase functions:log

# Filter for specific function
firebase functions:log --only backfillPlantJobData
firebase functions:log --only bulkImportResults
```

## Firestore Cost Estimation

### Backfill Costs (One-time)

For an organization with **N** exposure groups:
- **Reads:** N + 1 (groups + org doc)
- **Writes:** N + 1 (groups + org doc for EfSummary)

**Example:**
- 100 exposure groups
- Reads: 101 × $0.36 per 100,000 = $0.00036
- Writes: 101 × $1.08 per 100,000 = $0.00109
- **Total per org: ~$0.0015**

### Ongoing Costs

Import operations already read/write exposure groups, so the additional cost is minimal:
- No additional reads
- No additional writes (same transaction)
- **Additional cost per import: $0**

## Rollback Procedure

If issues are detected:

### 1. Rollback Functions Only

```bash
# Find previous deployment
firebase functions:list

# Rollback to previous version
# (Firebase doesn't have direct rollback, so redeploy previous code)
git checkout <previous-commit>
cd functions
npm run build
firebase deploy --only functions
```

### 2. Rollback Application Only

```bash
git checkout <previous-commit>
ng build --configuration production
firebase deploy --only hosting
```

### 3. Revert Firestore Data (If Needed)

⚠️ **This should rarely be needed** since plant/job fields are additive.

If you must remove the fields:

```javascript
// Script to remove plant/job fields
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

async function revertFields(orgId) {
  const groupsRef = db.collection(`organizations/${orgId}/exposureGroups`);
  const snapshot = await groupsRef.get();
  
  const batch = db.batch();
  let count = 0;
  
  snapshot.forEach(doc => {
    batch.update(doc.ref, {
      plantName: admin.firestore.FieldValue.delete(),
      jobName: admin.firestore.FieldValue.delete(),
      plantKey: admin.firestore.FieldValue.delete(),
      jobKey: admin.firestore.FieldValue.delete(),
      plantJobNeedsReview: admin.firestore.FieldValue.delete()
    });
    
    count++;
    if (count === 500) {
      // Firestore batch limit
      throw new Error('Use multiple batches for large collections');
    }
  });
  
  await batch.commit();
  console.log(`Reverted ${count} groups`);
}
```

## Troubleshooting

### Issue: Backfill Times Out

**Symptoms:**
- Function timeout error
- Some groups not processed

**Solution:**
```javascript
// Process in smaller batches
{
  "orgId": "org-id",
  "groupIds": ["group1", "group2", "group3"], // Specific groups only
  "dryRun": false
}
```

Run multiple times with different group IDs.

### Issue: High Number of Groups Flagged for Review

**Symptoms:**
- `flaggedForReviewCount` is very high (>30% of groups)

**Investigation:**
1. Get list of flagged groups:
   ```javascript
   functions.httpsCallable('listPlantJobReviewCandidates')({
     orgId: 'org-id',
     limit: 100
   })
   ```

2. Review common patterns
3. Determine if naming conventions need improvement

**Solution:**
- Document current naming conventions
- Communicate with users about best practices
- Plan for manual review UI in future release

### Issue: Extraction Quality is Poor

**Symptoms:**
- Many incorrect splits
- Users reporting wrong plant/job assignments

**Investigation:**
1. Check sample extractions
2. Review exposure group naming patterns
3. Check plant dictionary building

**Solution:**
- May need to adjust extraction heuristics
- Consider creating organization-specific rules
- Plan for manual correction interface

### Issue: Import Performance Degradation

**Symptoms:**
- Imports taking significantly longer
- Timeout errors on imports

**Investigation:**
1. Check function logs
2. Monitor execution times
3. Check Firestore query performance

**Solution:**
- May need to optimize plant dictionary loading
- Consider caching plant dictionary
- Review concurrent import limits

## Post-Deployment Tasks

### Week 1
- [ ] Monitor error logs daily
- [ ] Check with users about extraction quality
- [ ] Review flagged groups
- [ ] Document common patterns that need improvement

### Week 2-4
- [ ] Collect feedback on plant/job display in UI
- [ ] Identify organizations with high review flag counts
- [ ] Plan for manual review UI if needed
- [ ] Document any extraction edge cases

### Month 2+
- [ ] Analyze usage patterns
- [ ] Consider additional extraction strategies
- [ ] Plan for plant/job filtering features
- [ ] Consider plant hierarchy (sites, departments, etc.)

## Support Contact

For deployment issues:
- Technical Lead: [Name/Email]
- DevOps: [Name/Email]
- Firebase Console: https://console.firebase.google.com/

## Appendix: Testing Checklist

Before deploying to production, verify in staging/emulators:

### Backend Tests
- [ ] `backfillPlantJobData` with dry run
- [ ] `backfillPlantJobData` with actual update
- [ ] `getPlantJobBackfillStatus` returns correct data
- [ ] `listPlantJobReviewCandidates` returns flagged groups
- [ ] `bulkImportResults` creates plant/job fields
- [ ] EfSummary entries have plant/job fields

### Frontend Tests
- [ ] Scheduling Statistics shows plant/job columns
- [ ] Exposure Groups shows plant/job columns
- [ ] Data displays correctly
- [ ] Empty plant/job values handled gracefully
- [ ] No UI errors in console

### Integration Tests
- [ ] Import a new exposure group → plant/job extracted
- [ ] View in Scheduling Statistics → columns visible
- [ ] View in Exposure Groups → columns visible
- [ ] Run backfill → existing groups updated
- [ ] Check status → backfill info available

## Version History

- **v1.0** (2025): Initial deployment
