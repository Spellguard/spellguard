// SPDX-License-Identifier: Apache-2.0

export const REQUIRE_INTEGRATION_SERVICES =
  process.env.CI === 'true' ||
  process.env.REQUIRE_INTEGRATION_SERVICES === 'true';

export function markIntegrationUnavailable(message: string): false {
  if (REQUIRE_INTEGRATION_SERVICES) {
    throw new Error(message);
  }
  console.warn(`\n${message}\n`);
  return false;
}
