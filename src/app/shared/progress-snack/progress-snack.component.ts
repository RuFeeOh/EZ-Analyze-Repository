import { CommonModule } from '@angular/common';
import { Component, Inject } from '@angular/core';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MAT_SNACK_BAR_DATA } from '@angular/material/snack-bar';
import { BehaviorSubject } from 'rxjs';

export type ProgressSnackData = {
    label: string;
    progress$: BehaviorSubject<{ done: number; total: number }>;
};

@Component({
    selector: 'app-progress-snack',
    standalone: true,
    imports: [CommonModule, MatProgressBarModule],
    templateUrl: './progress-snack.component.html',
    styleUrl: './progress-snack.component.scss'
})
export class ProgressSnackComponent {
    constructor(@Inject(MAT_SNACK_BAR_DATA) public data: ProgressSnackData) { }
}
