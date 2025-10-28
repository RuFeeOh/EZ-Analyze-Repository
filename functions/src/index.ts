/**
 * Import function triggers from their respective submodules:
    const jobRef = db.doc(`organizations/${orgId}/importJobs/${jobId}`);
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */
import * as admin from "firebase-admin";


admin.initializeApp();
export { createOrganization, deleteOrganization, renameOrganization } from "./shared/organization";
export { bulkImportResults, undoImport, removeAgentsFromExposureGroups, recomputeEfBatch } from "./shared/import";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// export const helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });


