import { inject, Injectable } from '@angular/core';
import { MatSnackBar, MatSnackBarConfig, MatSnackBarRef } from '@angular/material/snack-bar';

@Injectable({ providedIn: 'root' })
export class SnackService {
    private snack = inject(MatSnackBar);
    private defaults: MatSnackBarConfig = {
        verticalPosition: 'top'
    };

    open(message: string, action?: string, config?: MatSnackBarConfig): MatSnackBarRef<any> {
        const merged: MatSnackBarConfig = { ...this.defaults, ...(config || {}) };
        return this.snack.open(message, action, merged);
    }

    openFromComponent<T>(component: any, config?: MatSnackBarConfig): MatSnackBarRef<T> {
        const merged: MatSnackBarConfig = { ...this.defaults, ...(config || {}) };
        return this.snack.openFromComponent(component, merged);
    }
}
