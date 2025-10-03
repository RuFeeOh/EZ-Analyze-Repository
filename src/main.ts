import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { setRootEnvironmentInjector } from './app/utils/root-environment-injector';

bootstrapApplication(AppComponent, appConfig)
  .then((appRef) => {
    // Store the root EnvironmentInjector for global access (e.g., decorators)
    try { setRootEnvironmentInjector(appRef.injector); } catch { /* no-op */ }
  })
  .catch((err) => console.error(err));
