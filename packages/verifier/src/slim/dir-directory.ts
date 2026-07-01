// SPDX-License-Identifier: Apache-2.0

/**
 * Verifier-side AGNTCY Directory client (gRPC).
 *
 * The slim profile's directory layer talks to a real AGNTCY `dir` node over
 * gRPC via the official `agntcy-dir` SDK. This implementation lives in the
 * verifier package — NOT in `@spellguard/amp` — on purpose: `agntcy-dir`
 * pulls in `@grpc/grpc-js` + `connect-node` and is Node-only, while amp's
 * `slim.ts` is also bundled into the Cloudflare-Workers client SDK (a static
 * import there would break the Workers build). Only the verifier ever calls
 * `directory.resolve/publish`, so the gRPC client is injected into the
 * profile bundle by the verifier's profile registry (see `profile/registry.ts`).
 *
 * Mapping between Spellguard's `{agentId, slimName, url}` and an AGNTCY OASF
 * record:
 *   - OASF record `name`     = the agentId (the key the router resolves by).
 *   - OASF `locators[].urls` = the agent's address; a `slim://<slimName>`
 *     locator carries the SLIM name, a plain `http(s)://…` locator carries an
 *     HTTP endpoint. resolve() reconstructs the AgentAddress from these.
 *
 * `core.v1.Record` wraps the OASF object in a `google.protobuf.Struct` field
 * named `data`, so records are built with `fromJson(RecordSchema, {data: oasf})`
 * and read back via `toJson(...).data`. searchRecords over the local store is
 * enough for single-deployment resolution (routing-publish is only needed for
 * cross-peer DHT discovery, deferred until cross-org SLIM lands).
 */

import { type JsonObject, create, fromJson, toJson } from '@bufbuild/protobuf';
import type {
  AgentAddress,
  PublishableRecord,
  SpellguardDirectory,
} from '@spellguard/amp/profile';
import { Client, Config, models } from 'agntcy-dir';

/** URL scheme we use inside an OASF locator to carry a SLIM name. */
const SLIM_LOCATOR_SCHEME = 'slim://';

/** The OASF object we store inside `core.v1.Record.data`. */
interface OasfData {
  name?: string;
  locators?: Array<{ type?: string; urls?: string[] }>;
  [key: string]: unknown;
}

export class GrpcDirDirectory implements SpellguardDirectory {
  readonly name = 'agntcy-dir';
  private client: Client | null = null;
  private readonly timeoutMs: number;

  /**
   * @param serverAddress - the dir gRPC address, `host:port` (e.g.
   *   `localhost:8888`). NOT an http URL — this is a gRPC endpoint.
   * @param timeoutMs - per-call gRPC deadline. Defaults to
   *   SPELLGUARD_VERIFIER_DIR_TIMEOUT_MS (5s). Without a deadline a
   *   slow-but-alive dir stalls recipient resolution on the message hot
   *   path indefinitely — the managed-Management fallback only fires on
   *   REJECTION, so a stuck call must actually fail.
   */
  constructor(
    private readonly serverAddress: string,
    timeoutMs?: number,
  ) {
    this.timeoutMs =
      timeoutMs ??
      (Number(process.env.SPELLGUARD_VERIFIER_DIR_TIMEOUT_MS) || 5_000);
  }

  private getClient(): Client {
    if (!this.client) {
      // Insecure mode (authMode defaults to ''). The verifier and dir share a
      // trust boundary (same task/host); TLS/SPIFFE can be layered later via
      // Config without touching callers.
      this.client = new Client(new Config(this.serverAddress));
    }
    return this.client;
  }

  async resolve(agentNameOrUrl: string): Promise<AgentAddress | null> {
    // Full URLs pass through unchanged — they're the endpoint itself, not a
    // dir entry. Mirrors the original directory's behavior.
    if (
      agentNameOrUrl.startsWith('http://') ||
      agentNameOrUrl.startsWith('https://')
    ) {
      return { agentId: agentNameOrUrl, url: agentNameOrUrl };
    }

    const query = create(models.search_v1.RecordQuerySchema, {
      type: models.search_v1.RecordQueryType.NAME,
      value: agentNameOrUrl,
    });
    const request = create(models.search_v1.SearchRecordsRequestSchema, {
      queries: [query],
      limit: 1,
    });

    // The SDK's high-level Client.searchRecords wrapper doesn't expose
    // CallOptions, so go one level down to the connect-es service client,
    // which takes a per-call `timeoutMs` deadline (sent as the gRPC
    // timeout header AND enforced client-side).
    const results = [];
    for await (const response of this.getClient().searchClient.searchRecords(
      request,
      { timeoutMs: this.timeoutMs },
    )) {
      results.push(response);
    }
    const record = results[0]?.record;
    if (!record) return null;

    const json = toJson(models.core_v1.RecordSchema, record) as {
      data?: OasfData;
    };
    const data = json.data;
    if (!data) return null;
    return this.toAddress(agentNameOrUrl, data);
  }

  async publish(card: PublishableRecord): Promise<void> {
    const oasf = this.toOasf(card);
    const record = fromJson(models.core_v1.RecordSchema, { data: oasf });
    // Same deadline rationale as resolve(): the high-level Client.push
    // wrapper doesn't expose CallOptions, so call the connect-es store
    // client directly with the per-call deadline.
    const stream = this.getClient().storeClient.push(
      (async function* () {
        yield record;
      })(),
      { timeoutMs: this.timeoutMs },
    );
    for await (const _ref of stream) {
      // Drain — push streams back one RecordRef per record; completing the
      // iteration surfaces any stream error (incl. deadline_exceeded).
    }
  }

  /** Project a PublishableRecord into a minimal valid OASF record. */
  private toOasf(card: PublishableRecord): JsonObject {
    const isHttp = card.endpoint.startsWith('http');
    const locatorUrl = isHttp
      ? card.endpoint
      : `${SLIM_LOCATOR_SCHEME}${card.endpoint}`;
    return {
      // Resolve key — the router looks records up by this exact name.
      name: card.agentId,
      version: 'v1.0.0',
      description: `Spellguard agent ${card.agentId}`,
      // OASF rejects major version 0; 1.0.0 is the current line.
      schema_version: '1.0.0',
      authors: [card.org ?? 'spellguard'],
      created_at: new Date().toISOString(),
      // OASF requires a valid skill from its taxonomy; Spellguard agents are
      // addressed by name/endpoint, not skill, so we stamp a single neutral
      // skill to satisfy validation. (Skill-based discovery is out of scope.)
      skills: [{ id: 201, name: 'images_computer_vision/image_segmentation' }],
      locators: [{ type: 'source_code', urls: [locatorUrl] }],
    };
  }

  /** Reconstruct an AgentAddress from a resolved OASF record. */
  private toAddress(fallbackId: string, data: OasfData): AgentAddress {
    const agentId = typeof data.name === 'string' ? data.name : fallbackId;
    let slimName: string | undefined;
    let url: string | undefined;
    for (const locator of data.locators ?? []) {
      for (const u of locator.urls ?? []) {
        if (u.startsWith(SLIM_LOCATOR_SCHEME)) {
          slimName = u.slice(SLIM_LOCATOR_SCHEME.length);
        } else if (u.startsWith('http://') || u.startsWith('https://')) {
          url = u;
        }
      }
    }
    return { agentId, slimName, url };
  }
}
