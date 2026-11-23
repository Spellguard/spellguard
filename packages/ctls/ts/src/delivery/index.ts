// SPDX-License-Identifier: Apache-2.0

/**
 * Signed deliveries (#1244), importable without the package root. The root
 * index also re-exports server-side attestation, which dynamically imports
 * `@phala/dstack-sdk`; agents and plugins that only verify deliveries import
 * this subpath so their bundles never pull server-only code.
 */
export {
  DELIVERY_AUTH_HEADERS,
  DELIVERY_AUTH_MAX_SKEW_MS,
  DELIVERY_AUTH_SCHEME,
  DELIVERY_AUTH_VERSION,
  DeliveryNonceCache,
  type DeliveryAuthFailure,
  type DeliveryNonceStore,
  type DeliveryVerdict,
  deliveryKeyId,
  deliverySigningString,
  signDelivery,
  verifyDelivery,
} from './delivery-auth';
