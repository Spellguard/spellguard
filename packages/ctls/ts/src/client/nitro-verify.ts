// SPDX-License-Identifier: Apache-2.0

/**
 * @spellguard/ctls - AWS Nitro Enclave Attestation Verification
 *
 * Verifies AWS Nitro Enclave attestation documents (COSE_Sign1 format).
 * Uses only Web Crypto APIs — works in Node.js, Cloudflare Workers, and browsers.
 *
 * Verification steps:
 *   1. Decode base64 → CBOR COSE_Sign1 structure
 *   2. Extract the embedded certificate chain
 *   3. Verify the certificate chain against the AWS Nitro root CA
 *   4. Verify the COSE_Sign1 signature using the leaf certificate's public key
 *   5. Extract PCR0 as the hardware measurement (enclave image hash)
 *   6. Compare PCR0 against expectedPcr0 constraint (if provided)
 */

// AWS Nitro Attestation Root CA certificate (PEM).
// This is the root of trust for all Nitro Enclave attestation documents.
// Source: https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip
const AWS_NITRO_ROOT_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYD
VQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4
MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQL
DANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEG
BSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb
48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZE
h8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkF
R+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYC
MQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPW
rfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6N
IwLz3/Y=
-----END CERTIFICATE-----`;

export interface NitroVerifyResult {
  verified: boolean;
  /** PCR values as hex strings (keyed by PCR index) */
  pcrs?: Record<number, string>;
  /** Hex-encoded raw user_data bytes from the attestation payload */
  userData?: string;
  /** Module ID string from the attestation payload (e.g. enclave instance identifier) */
  moduleId?: string;
  error?: string;
}

/**
 * Options for Nitro attestation verification.
 */
export interface NitroVerifyOptions {
  /**
   * Per-PCR pinning constraints. Keys are PCR indices (0–15).
   * When provided for a given index, the measured value must match exactly.
   * Takes precedence over the legacy `expectedPcr0` parameter for PCR0.
   */
  expectedPcrs?: Partial<Record<number, string>>;
  /**
   * Expected hex-encoded user_data bytes.
   * When set, the attestation document's user_data must match this value.
   * Used to bind attestation documents to a specific session or nonce.
   */
  expectedUserData?: string;
}

/**
 * Verify an AWS Nitro Enclave attestation document.
 *
 * @param attestationDocument - base64-encoded COSE_Sign1 attestation document
 * @param expectedPcr0 - optional expected PCR0 value (hex string) for image pinning
 * @returns Verification result with PCR values on success
 */
export async function verifyNitroHardwareSignature(
  attestationDocument: string,
  expectedPcr0?: string,
  options?: NitroVerifyOptions,
): Promise<NitroVerifyResult> {
  try {
    // Decode the base64 attestation document
    const docBytes = base64ToBytes(attestationDocument);

    // Parse the CBOR-encoded COSE_Sign1 structure
    const coseSign1 = decodeCoseSign1(docBytes);

    // The payload is a CBOR map containing the attestation claims
    const attestation = decodeCborMap(coseSign1.payload);

    // Verify certificate chain
    const cabundle = attestation.cabundle as Uint8Array[];
    const certificate = attestation.certificate as Uint8Array;

    if (!cabundle || !certificate) {
      return {
        verified: false,
        error: 'Attestation document missing certificate chain',
      };
    }

    // Verify the certificate chain against the AWS Nitro root cert
    const chainValid = await verifyCertificateChain(cabundle, certificate);

    if (!chainValid) {
      return {
        verified: false,
        error:
          'Certificate chain verification failed against AWS Nitro root CA',
      };
    }

    // Verify the COSE_Sign1 signature using the leaf certificate
    const signatureValid = await verifyCoseSignature(coseSign1, certificate);

    if (!signatureValid) {
      return {
        verified: false,
        error: 'COSE_Sign1 signature verification failed',
      };
    }

    // Extract PCR values
    const pcrMap = attestation.pcrs as Map<number, Uint8Array>;
    const pcr0 = pcrMap?.get(0);

    if (!pcr0) {
      return {
        verified: false,
        error: 'Attestation document missing PCR0',
      };
    }

    const pcrs: Record<number, string> = {};
    for (const [k, v] of pcrMap) {
      pcrs[k] = bytesToHex(v);
    }

    // Extract user_data (byte string → hex) and module_id (text string)
    const rawUserData = attestation.user_data as Uint8Array | undefined;
    const userData =
      rawUserData instanceof Uint8Array && rawUserData.length > 0
        ? bytesToHex(rawUserData)
        : undefined;
    const moduleId = attestation.module_id as string | undefined;

    // Build merged PCR constraint map.
    // options.expectedPcrs takes precedence; the legacy expectedPcr0 param
    // is added as PCR0 only when key 0 is not already present.
    const mergedPcrConstraints: Partial<Record<number, string>> = {
      ...(options?.expectedPcrs ?? {}),
    };
    if (expectedPcr0 !== undefined && !(0 in mergedPcrConstraints)) {
      mergedPcrConstraints[0] = expectedPcr0;
    }

    // Enforce all PCR constraints
    for (const [idx, expected] of Object.entries(mergedPcrConstraints)) {
      const pcrIndex = Number(idx);
      const measured = pcrs[pcrIndex];
      if (measured !== expected) {
        return {
          verified: false,
          pcrs,
          userData,
          moduleId,
          error: `PCR${pcrIndex} mismatch: expected ${expected}, measured ${measured}`,
        };
      }
    }

    // Enforce user_data binding constraint
    if (
      options?.expectedUserData !== undefined &&
      userData !== options.expectedUserData
    ) {
      return {
        verified: false,
        pcrs,
        userData,
        moduleId,
        error: `user_data mismatch: expected ${options.expectedUserData}, got ${userData}`,
      };
    }

    return { verified: true, pcrs, userData, moduleId };
  } catch (error) {
    return {
      verified: false,
      error: `Nitro attestation verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── CBOR/COSE helpers (minimal, Workers-compatible) ─────────────────

interface CoseSign1 {
  protectedHeader: Uint8Array;
  unprotectedHeader: unknown;
  payload: Uint8Array;
  signature: Uint8Array;
}

/**
 * Minimal CBOR decoder sufficient for Nitro attestation documents.
 * Handles: unsigned ints, byte strings, text strings, arrays, maps,
 * tagged values, and indefinite-length items (required by Nitro NSM output).
 */
function decodeCbor(
  data: Uint8Array,
  offset = 0,
): { value: unknown; bytesRead: number } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const initial = data[offset];
  const majorType = initial >> 5;
  const additionalInfo = initial & 0x1f;

  // ── Break code (0xFF) — terminates indefinite-length items ──
  if (initial === 0xff) {
    return { value: CBOR_BREAK, bytesRead: 1 };
  }

  // ── Indefinite-length items (additional info 31) ──
  if (additionalInfo === 31) {
    switch (majorType) {
      case 2: {
        // Indefinite-length byte string: sequence of definite-length
        // byte string chunks terminated by a break code.
        const chunks: Uint8Array[] = [];
        let pos = offset + 1;
        while (data[pos] !== 0xff) {
          const { value: chunk, bytesRead } = decodeCbor(data, pos);
          chunks.push(chunk as Uint8Array);
          pos += bytesRead;
        }
        pos++; // skip break byte
        const totalLen = chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        return { value: merged, bytesRead: pos - offset };
      }
      case 3: {
        // Indefinite-length text string
        const parts: string[] = [];
        let pos = offset + 1;
        while (data[pos] !== 0xff) {
          const { value: part, bytesRead } = decodeCbor(data, pos);
          parts.push(part as string);
          pos += bytesRead;
        }
        pos++; // skip break byte
        return { value: parts.join(''), bytesRead: pos - offset };
      }
      case 4: {
        // Indefinite-length array
        const arr: unknown[] = [];
        let pos = offset + 1;
        while (data[pos] !== 0xff) {
          const { value: item, bytesRead } = decodeCbor(data, pos);
          arr.push(item);
          pos += bytesRead;
        }
        pos++; // skip break byte
        return { value: arr, bytesRead: pos - offset };
      }
      case 5: {
        // Indefinite-length map
        const map = new Map<unknown, unknown>();
        let pos = offset + 1;
        while (data[pos] !== 0xff) {
          const { value: key, bytesRead: keySize } = decodeCbor(data, pos);
          pos += keySize;
          const { value: val, bytesRead: valSize } = decodeCbor(data, pos);
          pos += valSize;
          map.set(key, val);
        }
        pos++; // skip break byte
        return { value: map, bytesRead: pos - offset };
      }
      default:
        throw new Error(
          `Unsupported indefinite-length CBOR major type: ${majorType}`,
        );
    }
  }

  // ── Definite-length items ──
  let value: number | bigint;
  let headerSize: number;

  if (additionalInfo < 24) {
    value = additionalInfo;
    headerSize = 1;
  } else if (additionalInfo === 24) {
    value = data[offset + 1];
    headerSize = 2;
  } else if (additionalInfo === 25) {
    value = view.getUint16(offset + 1);
    headerSize = 3;
  } else if (additionalInfo === 26) {
    value = view.getUint32(offset + 1);
    headerSize = 5;
  } else if (additionalInfo === 27) {
    value = view.getBigUint64(offset + 1);
    headerSize = 9;
  } else {
    throw new Error(`Unsupported CBOR additional info: ${additionalInfo}`);
  }

  const length = Number(value);

  switch (majorType) {
    case 0: // Unsigned integer
      return { value: length, bytesRead: headerSize };

    case 1: // Negative integer
      return { value: -1 - length, bytesRead: headerSize };

    case 2: {
      // Byte string
      const bytes = data.slice(
        offset + headerSize,
        offset + headerSize + length,
      );
      return { value: bytes, bytesRead: headerSize + length };
    }

    case 3: {
      // Text string
      const textBytes = data.slice(
        offset + headerSize,
        offset + headerSize + length,
      );
      const text = new TextDecoder().decode(textBytes);
      return { value: text, bytesRead: headerSize + length };
    }

    case 4: {
      // Array
      const arr: unknown[] = [];
      let pos = offset + headerSize;
      for (let i = 0; i < length; i++) {
        const { value: item, bytesRead } = decodeCbor(data, pos);
        arr.push(item);
        pos += bytesRead;
      }
      return { value: arr, bytesRead: pos - offset };
    }

    case 5: {
      // Map
      const map = new Map<unknown, unknown>();
      let pos = offset + headerSize;
      for (let i = 0; i < length; i++) {
        const { value: key, bytesRead: keySize } = decodeCbor(data, pos);
        pos += keySize;
        const { value: val, bytesRead: valSize } = decodeCbor(data, pos);
        pos += valSize;
        map.set(key, val);
      }
      return { value: map, bytesRead: pos - offset };
    }

    case 6: {
      // Tagged value
      const { value: taggedValue, bytesRead } = decodeCbor(
        data,
        offset + headerSize,
      );
      return { value: taggedValue, bytesRead: headerSize + bytesRead };
    }

    case 7: // Simple values and floats
      if (additionalInfo === 20) return { value: false, bytesRead: 1 };
      if (additionalInfo === 21) return { value: true, bytesRead: 1 };
      if (additionalInfo === 22) return { value: null, bytesRead: 1 };
      throw new Error(`Unsupported CBOR simple value: ${additionalInfo}`);

    default:
      throw new Error(`Unsupported CBOR major type: ${majorType}`);
  }
}

/** Sentinel value for CBOR break codes (0xFF). */
const CBOR_BREAK = Symbol('CBOR_BREAK');

function decodeCoseSign1(data: Uint8Array): CoseSign1 {
  const { value } = decodeCbor(data);

  // COSE_Sign1 is a CBOR array tagged with 18
  const arr = value as unknown[];
  if (!Array.isArray(arr) || arr.length !== 4) {
    throw new Error(
      'Invalid COSE_Sign1 structure: expected array of 4 elements',
    );
  }

  return {
    protectedHeader: arr[0] as Uint8Array,
    unprotectedHeader: arr[1],
    payload: arr[2] as Uint8Array,
    signature: arr[3] as Uint8Array,
  };
}

function decodeCborMap(data: Uint8Array): Record<string, unknown> {
  const { value } = decodeCbor(data);
  const map = value as Map<unknown, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, val] of map) {
    result[String(key)] = val;
  }
  return result;
}

async function verifyCertificateChain(
  cabundle: Uint8Array[],
  leafCert: Uint8Array,
): Promise<boolean> {
  try {
    const rootDer = pemToDer(AWS_NITRO_ROOT_CERT_PEM);

    // Verify the root in cabundle matches our embedded root
    if (cabundle.length === 0) return false;

    const bundleRoot = cabundle[0];
    if (!arraysEqual(bundleRoot, rootDer)) {
      return false;
    }

    // Verify each certificate in the chain is signed by its parent
    const fullChain = [...cabundle, leafCert];
    for (let i = 1; i < fullChain.length; i++) {
      const parentCert = fullChain[i - 1];
      const childCert = fullChain[i];

      const valid = await verifyX509Signature(parentCert, childCert);
      if (!valid) return false;
    }

    return true;
  } catch {
    return false;
  }
}

async function verifyCoseSignature(
  coseSign1: CoseSign1,
  certificate: Uint8Array,
): Promise<boolean> {
  try {
    // Extract public key from the leaf certificate
    const publicKey = await importPublicKeyFromCert(certificate);

    // COSE_Sign1 Sig_structure: ["Signature1", protectedHeader, b"", payload]
    const sigStructure = encodeSigStructure(
      coseSign1.protectedHeader,
      coseSign1.payload,
    );

    // The Nitro attestation uses ECDSA with P-384 (ES384)
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-384' },
      publicKey,
      coseSign1.signature,
      sigStructure,
    );
  } catch {
    return false;
  }
}

function encodeSigStructure(
  protectedHeader: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  const context = new TextEncoder().encode('Signature1');
  const externalAad = new Uint8Array(0);

  const parts: Uint8Array[] = [];

  // Array header (4 elements)
  parts.push(new Uint8Array([0x84]));

  // Context string
  parts.push(encodeCborTextString(context));

  // Protected header (byte string)
  parts.push(encodeCborByteString(protectedHeader));

  // External AAD (empty byte string)
  parts.push(encodeCborByteString(externalAad));

  // Payload (byte string)
  parts.push(encodeCborByteString(payload));

  return concatBytes(...parts);
}

function encodeCborByteString(data: Uint8Array): Uint8Array {
  const header = encodeCborLength(2, data.length);
  return concatBytes(header, data);
}

function encodeCborTextString(data: Uint8Array): Uint8Array {
  const header = encodeCborLength(3, data.length);
  return concatBytes(header, data);
}

function encodeCborLength(majorType: number, length: number): Uint8Array {
  const mt = majorType << 5;
  if (length < 24) return new Uint8Array([mt | length]);
  if (length < 256) return new Uint8Array([mt | 24, length]);
  if (length < 65536) {
    const buf = new Uint8Array(3);
    buf[0] = mt | 25;
    new DataView(buf.buffer).setUint16(1, length);
    return buf;
  }
  const buf = new Uint8Array(5);
  buf[0] = mt | 26;
  new DataView(buf.buffer).setUint32(1, length);
  return buf;
}

async function verifyX509Signature(
  parentDer: Uint8Array,
  childDer: Uint8Array,
): Promise<boolean> {
  try {
    const parentKey = await importPublicKeyFromCert(parentDer);

    const { tbs, signature, algorithm } = parseX509ForVerification(childDer);

    // X.509 stores ECDSA signatures in DER format (SEQUENCE of two INTEGERs).
    // Web Crypto expects raw r||s format — convert before verifying.
    const rawSig = derSignatureToRaw(signature, 48); // P-384 = 48 bytes per component

    const hashAlg = algorithm === 'sha384' ? 'SHA-384' : 'SHA-256';
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: hashAlg },
      parentKey,
      rawSig,
      tbs,
    );
  } catch {
    return false;
  }
}

/**
 * Convert a DER-encoded ECDSA signature to raw r||s format.
 * DER: SEQUENCE { INTEGER r, INTEGER s }
 * Raw: r (fixed-length) || s (fixed-length)
 */
function derSignatureToRaw(
  derSig: Uint8Array,
  componentLength: number,
): Uint8Array {
  let offset = 0;

  // SEQUENCE tag
  if (derSig[offset] !== 0x30) throw new Error('Not a DER SEQUENCE');
  offset++;
  const { bytesRead: seqLenBytes } = parseAsn1Length(derSig, offset);
  offset += seqLenBytes;

  // INTEGER r
  if (derSig[offset] !== 0x02) throw new Error('Expected INTEGER for r');
  offset++;
  const { length: rLen, bytesRead: rLenBytes } = parseAsn1Length(
    derSig,
    offset,
  );
  offset += rLenBytes;
  const rBytes = derSig.slice(offset, offset + rLen);
  offset += rLen;

  // INTEGER s
  if (derSig[offset] !== 0x02) throw new Error('Expected INTEGER for s');
  offset++;
  const { length: sLen, bytesRead: sLenBytes } = parseAsn1Length(
    derSig,
    offset,
  );
  offset += sLenBytes;
  const sBytes = derSig.slice(offset, offset + sLen);

  // Pad or trim each component to the expected fixed length.
  // DER INTEGERs may have a leading 0x00 (if high bit set) or be shorter.
  const raw = new Uint8Array(componentLength * 2);
  copyIntegerToFixed(rBytes, raw, 0, componentLength);
  copyIntegerToFixed(sBytes, raw, componentLength, componentLength);
  return raw;
}

function copyIntegerToFixed(
  src: Uint8Array,
  dst: Uint8Array,
  dstOffset: number,
  length: number,
): void {
  if (src.length > length) {
    // Strip leading zero padding
    const trimmed = src.slice(src.length - length);
    dst.set(trimmed, dstOffset);
  } else if (src.length < length) {
    // Right-align (pad with leading zeros)
    dst.set(src, dstOffset + length - src.length);
  } else {
    dst.set(src, dstOffset);
  }
}

async function importPublicKeyFromCert(
  certDer: Uint8Array,
): Promise<Awaited<ReturnType<typeof crypto.subtle.importKey>>> {
  const spki = extractSpkiFromCert(certDer);

  return crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'ECDSA', namedCurve: 'P-384' },
    false,
    ['verify'],
  );
}

// ── ASN.1/DER parsing helpers ───────────────────────────────────────

function parseAsn1Length(
  data: Uint8Array,
  offset: number,
): { length: number; bytesRead: number } {
  const first = data[offset];
  if (first < 0x80) return { length: first, bytesRead: 1 };

  const numBytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    length = (length << 8) | data[offset + 1 + i];
  }
  return { length, bytesRead: 1 + numBytes };
}

function extractSpkiFromCert(certDer: Uint8Array): Uint8Array {
  let offset = 0;

  // Outer SEQUENCE
  if (certDer[offset] !== 0x30)
    throw new Error('Not a valid X.509 certificate');
  offset += 1;
  const { bytesRead: outerLenBytes } = parseAsn1Length(certDer, offset);
  offset += outerLenBytes;

  // tbsCertificate SEQUENCE
  if (certDer[offset] !== 0x30) throw new Error('Invalid tbsCertificate');
  offset += 1;
  const { bytesRead: tbsLenBytes } = parseAsn1Length(certDer, offset);
  offset += tbsLenBytes;

  // Skip fields in tbsCertificate to reach subjectPublicKeyInfo
  // Field 0: version [0] EXPLICIT (context tag 0xa0)
  if (certDer[offset] === 0xa0) {
    offset += 1;
    const { length: vLen, bytesRead: vLenBytes } = parseAsn1Length(
      certDer,
      offset,
    );
    offset += vLenBytes + vLen;
  }

  // Field 1: serialNumber (INTEGER)
  offset = skipAsn1Element(certDer, offset);
  // Field 2: signature (SEQUENCE)
  offset = skipAsn1Element(certDer, offset);
  // Field 3: issuer (SEQUENCE)
  offset = skipAsn1Element(certDer, offset);
  // Field 4: validity (SEQUENCE)
  offset = skipAsn1Element(certDer, offset);
  // Field 5: subject (SEQUENCE)
  offset = skipAsn1Element(certDer, offset);

  // Field 6: subjectPublicKeyInfo (SEQUENCE)
  const spkiStart = offset;
  const spkiEnd = skipAsn1Element(certDer, offset);

  return certDer.slice(spkiStart, spkiEnd);
}

function parseX509ForVerification(certDer: Uint8Array): {
  tbs: Uint8Array;
  signature: Uint8Array;
  algorithm: string;
} {
  let offset = 0;

  // Outer SEQUENCE
  if (certDer[offset] !== 0x30)
    throw new Error('Not a valid X.509 certificate');
  offset += 1;
  const { bytesRead: outerLenBytes } = parseAsn1Length(certDer, offset);
  offset += outerLenBytes;

  // tbsCertificate (the data that was signed)
  const tbsStart = offset;
  const tbsEnd = skipAsn1Element(certDer, offset);
  const tbs = certDer.slice(tbsStart, tbsEnd);
  offset = tbsEnd;

  // signatureAlgorithm SEQUENCE
  const algStart = offset;
  const algEnd = skipAsn1Element(certDer, offset);
  const algBytes = certDer.slice(algStart, algEnd);
  // ecdsa-with-SHA384 OID: 1.2.840.10045.4.3.3
  const algorithm = containsOid(
    algBytes,
    [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03],
  )
    ? 'sha384'
    : 'sha256';
  offset = algEnd;

  // signatureValue (BIT STRING)
  if (certDer[offset] !== 0x03)
    throw new Error('Expected BIT STRING for signature');
  offset += 1;
  const { length: sigLen, bytesRead: sigLenBytes } = parseAsn1Length(
    certDer,
    offset,
  );
  offset += sigLenBytes;
  // Skip the "unused bits" byte
  const signature = certDer.slice(offset + 1, offset + sigLen);

  return { tbs, signature, algorithm };
}

function skipAsn1Element(data: Uint8Array, offset: number): number {
  const pos = offset + 1;
  const { length, bytesRead } = parseAsn1Length(data, pos);
  return pos + bytesRead + length;
}

function containsOid(data: Uint8Array, oid: number[]): boolean {
  outer: for (let i = 0; i <= data.length - oid.length; i++) {
    for (let j = 0; j < oid.length; j++) {
      if (data[i + j] !== oid[j]) continue outer;
    }
    return true;
  }
  return false;
}

// ── Utility functions ───────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s/g, '');
  return base64ToBytes(b64);
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
