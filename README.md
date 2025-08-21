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

The data page is currently used for uploading of the excel spreadsheets. There is a table which allows the user to verify its the correct data before clicking the save button. Excel spreadsheets can have multiple exposureGroups so when parsing the data it's important to separate out the data into each exposureGroup

### Exceedance Fraction

The exceedance fraction page will show all the exceedance fractions for all the exposureGroups in the current organization. There will be a grid showing the exposureGroup, ExceedanceFraction, Calculation Date, and how many samples were used for the calculation. The grid will be sorted so the most recent calculated exceedance fractions are at the top. Each row will be able to expand to show the samples that were used. Above the grid will be a toggle to "Show Latest" which will filter the grid to show only the latest exceedance fraction per exposureGroup; this toggle will be on by default.


## Privacy and sharing

Users will be able to create an organization. This organizaiton will be scoped to themselves but they will also be able to share organizations with other users. In order to share an organization the user will navigate to the org page, select share on an org, and then type in the email of the person they'd like to share with. By default users will see all exposureGroups in the selected organiation even if it is shared. The user who owns an organization will be able to mark exposureGroups as private if they'd like to keep it private. By default all of them are shared.

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


## Monetization

Using Stripe's recurring payment process there will be a tiered payment process

| **Free**  | 1 user - 20 exposure groups Small teams/testing | **$0**
| **Professional**  | 5 users - 200 exposure groups  | **$199–$299**    
| **Enterprise**    | - Unlimited users/exposure groups  | **$600+**

Users will automatically be part of the free tier. In order to share an organization to 1-4 people the user will have to subscribe using Stripe. In order for a user to have more than 20 exposure groups, the user will have to subscribe using Stripe. If the user does not subscribe then the data will not be saved or the user cannot share. Once the user reaches the threshole for 200 exposure groups or is trying to share to more than 4 people then the user will have to subscribe to a higher tier using stripe.




## Ranges of Exceedance Fraction
<5%
5-20%
20+%

Gameify these ranges to help learn how the plants are faring

### Stripe setup (subscriptions)

1) Create a Stripe account (test mode is fine) and add Products/Prices for your tiers (e.g., price IDs like `price_PROFESSIONAL`, `price_ENTERPRISE`).

2) Create API keys and webhook secret
	 - Get your Secret key (Developers > API keys > Secret key) and store as Firebase env var:
		 - `firebase functions:config:set stripe.secret_key="sk_test_..."`
	 - Create a webhook endpoint for your project (Developers > Webhooks) with events:
		 - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
		 - Set URL to your deployed function (e.g., `https://<region>-<project>.cloudfunctions.net/stripeWebhook`). For local emulators see below.
	 - Save the webhook signing secret and set it:
		 - `firebase functions:config:set stripe.webhook_secret="whsec_..."`

3) Deploy functions and hosting
	 - `npm --prefix functions ci && npm --prefix functions run build`
	 - `firebase deploy --only functions,hosting`

4) Local development with emulators
	 - Start emulators + Angular app:
		 - `npm start`
	 - Use Stripe CLI to forward webhooks to emulator:
		 - `stripe listen --forward-to localhost:5001/<project-id>/us-central1/stripeWebhook`
	 - Export the signing secret to your functions env for local runs, or pass it via `.env`.

5) Frontend wiring
	 - Open `/billing` route in the app to subscribe or manage billing.
	 - Replace placeholder price IDs in `BillingComponent` with your real `price_...` IDs.
	 - In a real app, map Firebase Auth users to Stripe customers and store `customerId` under `/billing/customers/{uid}`. The sample writes subscription status to `/billing/customers/{customerId}` from the webhook.

Notes
 - API endpoints are exposed under `/api/*` via Firebase Hosting rewrites.
 - The Cloud Function `stripeWebhook` updates Firestore with subscription status. Use this to gate features (e.g., saving beyond free tier or sharing).