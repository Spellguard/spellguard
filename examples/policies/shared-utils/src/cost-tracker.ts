// SPDX-License-Identifier: Apache-2.0

/**
 * Simple cost tracking utility for external API calls
 * Helps monitor spend across different policies
 */

export interface CostRecord {
  policyName: string;
  timestamp: number;
  cost: number;
  apiProvider: string;
  requestType: string;
}

export class CostTracker {
  private records: CostRecord[] = [];
  private totalCost = 0;

  /**
   * Log an API call cost
   */
  logCost(
    policyName: string,
    cost: number,
    apiProvider: string,
    requestType = 'default',
  ): void {
    const record: CostRecord = {
      policyName,
      timestamp: Date.now(),
      cost,
      apiProvider,
      requestType,
    };

    this.records.push(record);
    this.totalCost += cost;
  }

  /**
   * Get total cost across all policies
   */
  getTotalCost(): number {
    return this.totalCost;
  }

  /**
   * Get cost for a specific policy
   */
  getPolicyCost(policyName: string): number {
    return this.records
      .filter((r) => r.policyName === policyName)
      .reduce((sum, r) => sum + r.cost, 0);
  }

  /**
   * Get cost for a specific API provider
   */
  getProviderCost(apiProvider: string): number {
    return this.records
      .filter((r) => r.apiProvider === apiProvider)
      .reduce((sum, r) => sum + r.cost, 0);
  }

  /**
   * Get cost breakdown by policy
   */
  getCostByPolicy(): Record<string, number> {
    const breakdown: Record<string, number> = {};
    for (const record of this.records) {
      breakdown[record.policyName] =
        (breakdown[record.policyName] || 0) + record.cost;
    }
    return breakdown;
  }

  /**
   * Get cost breakdown by API provider
   */
  getCostByProvider(): Record<string, number> {
    const breakdown: Record<string, number> = {};
    for (const record of this.records) {
      breakdown[record.apiProvider] =
        (breakdown[record.apiProvider] || 0) + record.cost;
    }
    return breakdown;
  }

  /**
   * Get all cost records
   */
  getAllRecords(): CostRecord[] {
    return [...this.records];
  }

  /**
   * Get records within a time range
   */
  getRecordsByTimeRange(startMs: number, endMs: number): CostRecord[] {
    return this.records.filter(
      (r) => r.timestamp >= startMs && r.timestamp <= endMs,
    );
  }

  /**
   * Get cost within a time range
   */
  getCostByTimeRange(startMs: number, endMs: number): number {
    return this.getRecordsByTimeRange(startMs, endMs).reduce(
      (sum, r) => sum + r.cost,
      0,
    );
  }

  /**
   * Clear all records (useful for testing)
   */
  clear(): void {
    this.records = [];
    this.totalCost = 0;
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    totalCost: number;
    totalRequests: number;
    avgCostPerRequest: number;
    byPolicy: Record<string, number>;
    byProvider: Record<string, number>;
  } {
    return {
      totalCost: this.totalCost,
      totalRequests: this.records.length,
      avgCostPerRequest:
        this.records.length > 0 ? this.totalCost / this.records.length : 0,
      byPolicy: this.getCostByPolicy(),
      byProvider: this.getCostByProvider(),
    };
  }
}

// Singleton instance for global cost tracking
export const globalCostTracker = new CostTracker();
