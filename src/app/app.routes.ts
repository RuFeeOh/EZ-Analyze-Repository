import { Routes } from '@angular/router';
import { HomeComponent } from './pages/home/home.component';
import { DataComponent } from './pages/data/data.component';
import { OrganizationSelectorComponent } from './pages/organization-selector/organization-selector.component';
import { ExceedanceFractionComponent } from './pages/exceedance-fraction/exceedance-fraction.component';
import { ExposureGroupsComponent } from './pages/exposure-groups/exposure-groups.component';
import { AgentsComponent } from './pages/agents/agents.component';
import { SchedulingStatisticsComponent } from './pages/scheduling-statistics/scheduling-statistics.component';
import { AdminComponent } from './pages/admin/admin.component';

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
    },
    {
        path: 'exceedance-fraction',
        title: 'Exceedance Fraction',
        component: ExceedanceFractionComponent,
    }
    ,
    {
        path: 'exposure-groups',
        title: 'Exposure Groups',
        component: ExposureGroupsComponent,
    }
    ,
    {
        path: 'agents',
        title: 'Agents',
        component: AgentsComponent,
    },
    {
        path: 'scheduling-statistics',
        title: 'Scheduling Statistics',
        component: SchedulingStatisticsComponent,
    },
    {
        path: 'admin',
        title: 'Admin',
        component: AdminComponent,
    }
];
