import { Injectable, signal } from '@angular/core';

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed';
export type BackgroundTaskKind = 'upload' | 'compute' | 'other';

export interface BackgroundTask {
    id: string;
    label: string;
    detail?: string;
    kind: BackgroundTaskKind;
    done?: number;
    total?: number;
    indeterminate?: boolean;
    startedAt: number;
    status: BackgroundTaskStatus;
    error?: string;
}

@Injectable({ providedIn: 'root' })
export class BackgroundStatusService {
    private _tasks = signal<BackgroundTask[]>([]);
    readonly tasks = this._tasks.asReadonly();

    startTask(input: { label: string; detail?: string; kind?: BackgroundTaskKind; total?: number; indeterminate?: boolean }): string {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const task: BackgroundTask = {
            id,
            label: input.label,
            detail: input.detail,
            kind: input.kind || 'other',
            done: input.total ? 0 : undefined,
            total: input.total,
            indeterminate: input.indeterminate ?? (input.total === undefined),
            startedAt: Date.now(),
            status: 'running',
        };
        this._tasks.update(tasks => [task, ...tasks]);
        return id;
    }

    updateTask(id: string, patch: Partial<Omit<BackgroundTask, 'id' | 'startedAt'>>): void {
        this._tasks.update(list => {
            const idx = list.findIndex(t => t.id === id);
            if (idx === -1) return list;
            const next: BackgroundTask = { ...list[idx], ...patch } as BackgroundTask;
            if (next.total !== undefined && next.done !== undefined) {
                next.indeterminate = false;
            }
            const copy = [...list];
            copy[idx] = next;
            return copy;
        });
    }

    completeTask(id: string, detail?: string): void {
        this.updateTask(id, { status: 'completed', detail });
        // auto-remove after a short delay
        setTimeout(() => this.removeTask(id), 4000);
    }

    failTask(id: string, error?: string): void {
        this.updateTask(id, { status: 'failed', error });
        // Do not auto-remove failed tasks; let the user dismiss them manually from the UI
    }

    removeTask(id: string): void {
        this._tasks.update(tasks => tasks.filter(t => t.id !== id));
    }
}
