# EZAnalyze

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 19.1.7.

## Coding standards

The app should try to prioritize trying to use signals over rxjs observables when possible. Try to follow the DRY (don't repeat yourself) pattern. 

## App Description

This apps goal is to help expedite the analysis of exceedance probabilities (hereafter known as exceedance franction or EF). The app will allow upload of excel documents for exposureGroups which will have a sampleDate and Time Weighted Average (TWA) and every upload will create a new ExceedanceFraction and store the which samples were part of the EF. The goal is to create a running history for exposureGroups for easy anaylsis of how an exposureGroup has performed over time.

## Exceedance Fraction Calculation

Exceedance fractions are calculated by sorting all the sample data by date and taking the 6 (six) most recent samples and running the exceedance fraction formula on those 6.

Note: EF recomputation is performed server-side by a Cloud Function on writes to `exposureGroups`. Clients cannot set `LatestExceedanceFraction` or `ExceedanceFractionHistory`; Firestore rules enforce this and only the function updates those fields.

## Pages

### Org

The user can create an organizations. Upon creating an organization, the newly created org will be selected. The user can create, select, and delete any of the orgs in their selection. This page will also show orgs shared by other users which will be marked differently. Users will not be able to delete organizations which are not their own.

### Data

The data page is currently used for uploading of the excel spreadsheets. There is a table which allows the user to verify its the correct data before clicking the save button. Excel spreadsheets can have multiple exposureGroups so when parsing the data it's important to separate out the data into each exposureGroup. When clicking save, the exposure groups should be checked against the Agents in an organization to see if they exist or not. If they all exist then save will work no problem. If there is one or more agents missing, the user will be prompted to input the OEL for each agent. There will also be a toggle to "Assume 0.05" which will populate every agent found in the import with 0.05 as the OEL.

### Exceedance Fraction

The exceedance fraction page will show all the exceedance fractions for all the exposureGroups in the current organization. There will be a grid showing the exposureGroup, ExceedanceFraction, Calculation Date, and how many samples were used for the calculation. The grid will be sorted so the most recent calculated exceedance fractions are at the top. Each row will be able to expand to show the samples that were used. Above the grid will be a toggle to "Show Latest" which will filter the grid to show only the latest exceedance fraction per exposureGroup; this toggle will be on by default.

### Agents

This agent page will allow user to CRUD agents. Agents will consist of a Name and OEL. There will be a grid with the Agents, OEL, and the count of ExpsoureGroups using the Agent. Each agent row will expand to show the exposure groups which use the agent. When calculating an exceedance fraction, the Agent should be looked up and, if not found, ask the user what the OEL for this new agent should be then the OEL from the agent should be used to calculate the Exceedance Fraction.

## Plant/Job Extraction

The application automatically extracts plant and job information from exposure group names for better organization and filtering. See [PLANT-JOB-EXTRACTION.md](PLANT-JOB-EXTRACTION.md) for detailed documentation on:

- How extraction works (dash separation, stop words, job terms, etc.)
- Confidence scoring and review flags
- Running the backfill process for existing data
- Best practices for naming exposure groups

**Quick Example:**
- Input: `"Fort Smith - Bagging"`
- Output: Plant: `"Fort Smith"`, Job: `"Bagging"`

All new imports automatically extract plant/job data. For existing data, use the `backfillPlantJobData` Cloud Function.

## Privacy and sharing

Users will be able to create an organization. This organizaiton will be scoped to themselves but they will also be able to share organizations with other users. In order to share an organization the user will navigate to the org page, select share on an org, and then type in the email of the person they'd like to share with. By default users will see all exposureGroups in the selected organiation even if it is shared. The user who owns an organization will be able to mark exposureGroups as private if they'd like to keep it private. By default all of them are shared.

## Development server

To start a local development server, run:

```bash
npm start
```

or in VsCode select the debugger and play the `npm start` command

the VsCode will auto open 

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Karma](https://karma-runner.github.io) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.







## Ranges of Exceedance Fraction
<5%
5-20%
20+%

Gameify these ranges to help learn how the plants are faring