import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { SnackService } from '../../services/ui/snack.service';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatTooltipModule
  ],
  templateUrl: './admin.component.html',
  styleUrl: './admin.component.scss'
})
export class AdminComponent {
  private functions = inject(Functions);
  private snackService = inject(SnackService);

  // State signals
  backfillRunning = signal(false);
  backfillResult = signal<any>(null);

  /**
   * Trigger the automatic backfill for all organizations
   */
  async triggerBackfill() {
    const confirmMessage = 
      'This will trigger plant/job extraction for all organizations that haven\'t been processed yet.\n\n' +
      'Organizations that already have plant/job data will be skipped.\n\n' +
      'Continue?';
    
    if (!window.confirm(confirmMessage)) {
      return;
    }

    this.backfillRunning.set(true);
    this.backfillResult.set(null);

    try {
      const callable = httpsCallable<{}, any>(
        this.functions,
        'triggerAutoBackfill'
      );
      
      const result = await callable({});
      
      this.backfillResult.set(result.data);
      
      if (result.data?.ok) {
        const successCount = result.data.results?.filter((r: any) => r.status === 'success').length || 0;
        const skippedCount = result.data.results?.filter((r: any) => r.status === 'skipped').length || 0;
        const errorCount = result.data.results?.filter((r: any) => r.status === 'error').length || 0;
        
        this.snackService.success(
          `Backfill completed! ${successCount} org(s) processed, ${skippedCount} skipped, ${errorCount} errors`
        );
      } else {
        this.snackService.error('Backfill completed with errors. Check results below.');
      }
    } catch (e: any) {
      console.error('Failed to trigger backfill', e);
      this.snackService.error(`Failed to trigger backfill: ${e?.message || 'Unknown error'}`);
      this.backfillResult.set({ error: e?.message || 'Unknown error' });
    } finally {
      this.backfillRunning.set(false);
    }
  }

  /**
   * Get status badge color based on result status
   */
  getStatusColor(status: string): string {
    switch (status) {
      case 'success':
        return 'success';
      case 'skipped':
        return 'info';
      case 'error':
        return 'error';
      default:
        return 'default';
    }
  }

  /**
   * Get status icon based on result status
   */
  getStatusIcon(status: string): string {
    switch (status) {
      case 'success':
        return 'check_circle';
      case 'skipped':
        return 'info';
      case 'error':
        return 'error';
      default:
        return 'help';
    }
  }

  /**
   * Helper to get backfill results safely
   */
  private getBackfillResults(): any[] {
    return this.backfillResult()?.results ?? [];
  }

  /**
   * Get count of successful backfills
   */
  getSuccessCount(): number {
    return this.getBackfillResults().filter((r: any) => r.status === 'success').length;
  }

  /**
   * Get count of skipped backfills
   */
  getSkippedCount(): number {
    return this.getBackfillResults().filter((r: any) => r.status === 'skipped').length;
  }

  /**
   * Get count of failed backfills
   */
  getErrorCount(): number {
    return this.getBackfillResults().filter((r: any) => r.status === 'error').length;
  }
}
