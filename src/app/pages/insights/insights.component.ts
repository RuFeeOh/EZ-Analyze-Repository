import { Component } from '@angular/core';
import { Chart, registerables } from 'chart.js';

@Component({
  selector: 'ez-insights',
  templateUrl: './insights.component.html',
  styleUrls: ['./insights.component.scss']
})
export class InsightsComponent {
  constructor() {
    Chart.register(...registerables);
  }

  ngOnInit() {
    this.initializeSparkCharts();
  }

  initializeSparkCharts() {
    const ctx = document.getElementById('sparkChart') as HTMLCanvasElement;
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May'],
        datasets: [{
          data: [10, 20, 15, 30, 25],
          borderColor: '#42A5F5',
          fill: false,
          tension: 0.4
        }]
      },
      options: {
        plugins: {
          legend: {
            display: false
          }
        },
        scales: {
          x: {
            display: false
          },
          y: {
            display: false
          }
        }
      }
    });
  }
}
