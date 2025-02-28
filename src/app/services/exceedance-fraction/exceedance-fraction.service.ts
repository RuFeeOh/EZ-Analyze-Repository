import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class ExceedanceFractionService {

  constructor() { }

  public calculateExceedanceProbability(measurements: number[], OEL: number): number {

    // Step 2: Log-transform the data
    const logMeasurements = measurements.map(x => Math.log(x));

    // Step 3: Calculate the mean and standard deviation
    const mean = logMeasurements.reduce((sum, val) => sum + val, 0) / logMeasurements.length;

    const variance = logMeasurements.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (logMeasurements.length - 1);
    const stdDev = Math.sqrt(variance);


    // Calculate exceedance probability
    const logOEL = Math.log(OEL);
    const zScore = (logOEL - mean) / stdDev;
    const exceedanceProbability = 1 - this.normalCDF(zScore);
    return exceedanceProbability;
  }

  // CDF for standard normal distribution (using approximation)
  private normalCDF(x: number) {
    return (1 - this.erf(-x / Math.sqrt(2))) / 2;
  }

  // Error function approximation using Abramowitz and Stegun formula
  private erf(x: number) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);

    // Coefficients for approximation
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    // Abramowitz and Stegun approximation formula
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return sign * y;
  }
}
