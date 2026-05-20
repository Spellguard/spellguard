// SPDX-License-Identifier: Apache-2.0

/**
 * DynamoDB-backed NonceStore for AWS Nitro Enclave deployments.
 *
 * Uses conditional PutItem for atomic duplicate detection.
 * Eviction is handled by DynamoDB TTL on the `expiresAt` attribute,
 * so evictExpired() is a no-op.
 */

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';

import type { NonceStore } from './nonce-store';

const NONCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function createDynamoDBNonceStore(
  tableName: string,
  client?: DynamoDBClient,
): NonceStore {
  const ddb = client ?? new DynamoDBClient({});

  return {
    async insertIfAbsent(nonce: string, timestampMs: number): Promise<boolean> {
      const expiresAt = Math.floor((timestampMs + NONCE_TTL_MS) / 1000);

      try {
        await ddb.send(
          new PutItemCommand({
            TableName: tableName,
            Item: {
              nonce: { S: nonce },
              timestamp_ms: { N: String(timestampMs) },
              expiresAt: { N: String(expiresAt) },
            },
            ConditionExpression: 'attribute_not_exists(nonce)',
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          return false; // Duplicate nonce
        }
        throw err;
      }
    },

    async evictExpired(): Promise<number> {
      // DynamoDB TTL handles eviction automatically — no-op
      return 0;
    },

    async count(): Promise<number> {
      const result = await ddb.send(
        new ScanCommand({
          TableName: tableName,
          Select: 'COUNT',
        }),
      );
      return result.Count ?? 0;
    },

    close(): void {
      // DynamoDB client doesn't need explicit cleanup
    },
  };
}
