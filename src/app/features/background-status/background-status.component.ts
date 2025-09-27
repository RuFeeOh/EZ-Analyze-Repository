import { CommonModule } from '@angular/common';
import { Component, inject, signal, computed, Signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatButtonModule } from '@angular/material/button';
import { BackgroundStatusService, BackgroundTask } from '../../services/background-status/background-status.service';

@Component({
    selector: 'app-background-status',
    standalone: true,
    imports: [CommonModule, MatIconModule, MatProgressBarModule, MatButtonModule],
    templateUrl: './background-status.component.html',
    styleUrl: './background-status.component.scss'
})
export class BackgroundStatusComponent {
    private svc = inject(BackgroundStatusService);
    private collapsed = signal(false);

    tasks: Signal<BackgroundTask[]> = this.svc.tasks;
    isShowing: Signal<boolean> = computed(() => this.tasks().length > 0);
    isCollapsed: Signal<boolean> = computed(() => this.collapsed());

    toggle() { this.collapsed.set(!this.collapsed()); }

    trackById(_: number, item: any) { return item.id; }
    remove(id: string) { this.svc.removeTask(id); }
}
