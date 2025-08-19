# EZAnalyze

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 19.1.7.

## App Description

This apps goal is to help expedite the analysis of exceedance probabilities (hereafter known as exceedance franction or EF). The app will allow upload of excel documents for exposureGroups which will have a sampleDate and Time Weighted Average (TWA) and every upload will create a new ExceedanceFraction and store the which samples were part of the EF. The goal is to create a running history for exposureGroups for easy anaylsis of how an exposureGroup has performed over time.

## Exceedance Fraction Calculation

Exceedance fractions are calculated by sorting all the sample data by date and taking the 6 (six) most recent samples and running the exceedance fraction formula on those 6.

## Pages

### Data

The data page is currently used for uploading of the excel spreadsheets. There is a table which allows the user to verify its the correct data before clicking the save button. Excel spreadsheets can have multiple exposureGroups so when parsing the data it's important to separate out the data into each exposureGroup

### Exceedance Fraction

The exceedance fraction page will show all the exceedance fractions for all the exposureGroups. There will be a grid showing the exposureGroup, ExceedanceFraction, Calculation Date, and how many samples were used for the calculation. The grid will be sorted so the most recent calculated exceedance fractions are at the top. Each row will be able to expand to show the samples that were used. Above the grid will be a toggle to "Show Latest" which will filter the grid to show only the latest exceedance fraction per exposureGroup; this toggle will be on by default.

## Development server

To start a local development server, run:

```bash
ng serve
```

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