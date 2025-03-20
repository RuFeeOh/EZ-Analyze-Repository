import { Routes } from '@angular/router';

export const routes: Routes = [
    {
        path: 'home',
        title: 'home',
        loadChildren: () =>
            import('./pages/home/home.component').then(m => m.HomeComponent)
    },
    {
        path: 'org',
        title: 'Org Selector',
        loadChildren: () =>
            import('./pages/organization-selector/organization-selector.component').then(m => m.OrganizationSelectorComponent)
    },
    {
        path: 'data',
        title: 'Data',
        loadChildren: () =>
            import('./pages/data/data.component').then(m => m.DataComponent)
    }
];
