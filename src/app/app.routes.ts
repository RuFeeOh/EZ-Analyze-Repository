import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { DataComponent } from './pages/data/data.component';
import { OrganizationSelectorComponent } from './pages/organization-selector/organization-selector.component';
import { ExceedanceFractionComponent } from './pages/exceedance-fraction/exceedance-fraction.component';
import { canActivate, redirectUnauthorizedTo } from '@angular/fire/auth-guard';
import { LoginComponent } from './pages/login/login.component';
import { InsightsComponent } from './pages/insights/insights.component';

const redirectToLogin = () => redirectUnauthorizedTo(['login']);

export const routes: Routes = [
    {
        path: 'home',
        title: 'home',
        component: HomeComponent,
        canActivate: [redirectToLogin],
    },
    {
        path: 'org',
        title: 'Org Selector',
        component: OrganizationSelectorComponent,
        canActivate: [redirectToLogin],
    },
    {
        path: 'data',
        title: 'Data',
        component: DataComponent,
        canActivate: [redirectToLogin],
    },
    {
        path: 'exceedance-fraction',
        title: 'Exceedance Fraction',
        component: ExceedanceFractionComponent,
        canActivate: [redirectToLogin],
    },
    {
        path: 'insights',
        title: 'Insights',
        component: InsightsComponent,
        canActivate: [redirectToLogin],
    },
    {
        path: 'login',
        title: 'Login',
        component: LoginComponent,
    }
];
