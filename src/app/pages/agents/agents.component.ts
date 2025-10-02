import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { SnackService } from '../../services/ui/snack.service';
import { AgentService } from '../../services/agent/agent.service';
import { OrganizationService } from '../../services/organization/organization.service';
import { Firestore } from '@angular/fire/firestore';
import { collection } from 'firebase/firestore';
import { collectionData } from '@angular/fire/firestore';
import { Observable, combineLatest, map } from 'rxjs';
import { NewAgentDialogComponent } from '../agents/new-agent-dialog.component';
import { EzTableComponent } from '../../features/ez-table/ez-table.component';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

interface AgentView {
    Name: string;
    OELNumber: number;
    UsageCount: number;
    Groups: string[];
}

@Component({
    selector: 'app-agents',
    standalone: true,
    imports: [CommonModule, MatButtonModule, MatIconModule, MatDialogModule, MatProgressSpinnerModule, EzTableComponent],
    templateUrl: './agents.component.html',
    styleUrl: './agents.component.scss',
})
export class AgentsComponent {
    private agentService = inject(AgentService);
    private orgService = inject(OrganizationService);
    private dialog = inject(MatDialog);
    private snack = inject(SnackService);
    private firestore = inject(Firestore);

    agents$!: Observable<AgentView[]>;

    constructor() {
        const orgId = this.orgService.orgStore.currentOrg()?.Uid || 'unknown';
        const agents$ = this.agentService.list(orgId);
        const groups$ = collectionData(collection(this.firestore as any, `organizations/${orgId}/exposureGroups`) as any, { idField: 'Uid' }) as Observable<any[]>;
        this.agents$ = combineLatest([agents$, groups$]).pipe(
            map(([agents, groups]) => {
                const list = (agents || []).map(a => {
                    const usedIn = (groups || [])
                        .filter((g: any) => Array.isArray(g?.Results) && g.Results.some((r: any) => (r?.Agent || '').trim() === a.Name))
                        .map((g: any) => g?.ExposureGroup || g?.Group || '');
                    return { Name: a.Name, OELNumber: a.OELNumber, UsageCount: usedIn.length, Groups: usedIn } as AgentView;
                });
                return list.sort((x, y) => x.Name.localeCompare(y.Name));
            })
        );
    }

    // Provide detail rows for ez-table: map the agent's Groups (string[])
    // to an array of objects with an ExposureGroup property so the detail
    // table can render a single column named 'ExposureGroup'.
    detailForAgent = (a: AgentView) => (a?.Groups || []).map(g => ({ ExposureGroup: g }));

    // Provide a stable key for row identity/expansion
    keyForAgent = (a: AgentView) => (a?.Name || '').toLowerCase();

    async addAgent() {
        const ref = this.dialog.open(NewAgentDialogComponent, { width: '420px', data: { mode: 'create' } });
        const result = await ref.afterClosed().toPromise();
        if (!result) return;
        try {
            const orgId = this.orgService.orgStore.currentOrg()?.Uid;
            if (!orgId) throw new Error('No org');
            await this.agentService.upsert(orgId, { Name: result.Name, OELNumber: Number(result.OELNumber) } as any);
            this.snack.open('Agent saved.', 'OK', { duration: 2000 });
        } catch {
            this.snack.open('Failed to save agent.', 'Dismiss', { duration: 3000 });
        }
    }

    async editAgent(a: AgentView) {
        const ref = this.dialog.open(NewAgentDialogComponent, { width: '420px', data: { mode: 'edit', agent: a } });
        const result = await ref.afterClosed().toPromise();
        if (!result) return;
        try {
            const orgId = this.orgService.orgStore.currentOrg()?.Uid;
            if (!orgId) throw new Error('No org');
            await this.agentService.upsert(orgId, { Name: result.Name, OELNumber: Number(result.EOLNumber ?? result.OELNumber) } as any);
            this.snack.open('Agent updated.', 'OK', { duration: 2000 });
        } catch {
            this.snack.open('Failed to update agent.', 'Dismiss', { duration: 3000 });
        }
    }

    async deleteAgent(a: AgentView) {
        if (!confirm(`Delete agent "${a.Name}"?`)) return;
        try {
            const orgId = this.orgService.orgStore.currentOrg()?.Uid;
            if (!orgId) throw new Error('No org');
            await this.agentService.remove(orgId, a.Name);
            this.snack.open('Agent deleted.', 'OK', { duration: 2000 });
        } catch {
            this.snack.open('Failed to delete agent.', 'Dismiss', { duration: 3000 });
        }
    }
}
