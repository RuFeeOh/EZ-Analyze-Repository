import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { DataComponent } from './pages/data/data.component';
import { OrganizationSelectorComponent } from './pages/organization-selector/organization-selector.component';

export const routes: Routes = [
    {
        path: 'home',
        title: 'home',
        component: HomeComponent,
    },
    {
        path: 'org',
        title: 'Org Selector',
        component: OrganizationSelectorComponent,
    },
    {
        path: 'data',
        title: 'Data',
        component: DataComponent,
    }
];
