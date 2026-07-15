/**
 * reconcile.ts — merge N source snapshots into one FeedMessage.
 *
 * Strategy: per-vehicle dedupe with freshest-wins, keyed on
 * `vehicle.vehicle.id` (falling back to `entity.id` for feeds that
 * don't populate the vehicle descriptor). When two sources report
 * the same `vehicle.timestamp` for the same vehicle id, the
 * earlier-declared source wins -- primary over extras, in
 * declaration order. This keeps the merge deterministic and
 * matches the "primary is authoritative" mental model: the
 * primary is the operator's main feed, extras are mirrors /
 * backups / community feeds that may add vehicles the primary
 * missed.
 *
 * Sources that fail to decode are dropped (not thrown) so one
 * malformed upstream doesn't take the reconciled stream down.
 * The poller logs decode failures at the source level; we don't
 * re-log them here.
 *
 * The reconciled `header.timestamp` is the wall-clock at reconcile
 * time (NOT the max of source timestamps) so the consumer can
 * tell how fresh the served snapshot is independent of which
 * sources contributed. `gtfs_realtime_version` is '2.0' unless
 * every contributing source agreed on the same non-2.0 value --
 * the only realistic non-2.0 case is the rare 1.0 outlier feed.
 *
 * Returns the reconciled bytes + a small summary of which sources
 * contributed (so the poller can log it for observability).
 */
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { FeedMessage, FeedEntity, FeedHeader } = GtfsRealtimeBindings.transit_realtime;

export interface SourceSnapshot {
  url: string;
  role: 'primary' | 'extra';
  bytes: Uint8Array;
  fetchedAt: Date;
  appliedAt: Date;
  entityCount: number;
}

export interface Reconciled {
  bytes: Uint8Array;
  entityCount: number;
  /** URLs that contributed at least one entity to the result. */
  sources: string[];
  /** URLs that were inputs but had nothing to contribute (0 entities). */
  empty: string[];
  /** URLs that were inputs but failed to decode (malformed). */
  failed: string[];
}

export function reconcile(sources: SourceSnapshot[]): Reconciled {
  // 1. Decode each source. Drop failures; the poller logs them
  //    at the source level. We want one bad upstream to not take
  //    the merged stream down.
  const decoded: Array<{ url: string; role: 'primary' | 'extra'; msg: any; entityCount: number }> = [];
  const failed: string[] = [];
  for (const s of sources) {
    try {
      const msg = FeedMessage.decode(s.bytes);
      decoded.push({ url: s.url, role: s.role, msg, entityCount: msg.entity?.length ?? 0 });
    } catch {
      failed.push(s.url);
    }
  }

  // 2. Per-vehicle dedupe. Map keyed on the operator-assigned
  //    vehicle id; entry stores the entity + its freshness + the
  //    source URL (for observability). Source order in `decoded`
  //    is primary first, then extras in declaration order (the
  //    poller constructs it that way), so the first occurrence
  //    of a vehicle id wins ties on equal timestamps.
  //    Empty-key entities (no VehicleDescriptor.id, no entity.id)
  //    fall under the empty-string bucket -- best-effort dedupe
  //    that at least surfaces a position to consumers.
  const byVehicle = new Map<string, { entity: any; ts: number; url: string; role: 'primary' | 'extra' }>();
  const sourcesWithEntities = new Set<string>();
  for (const { msg, url, role } of decoded) {
    const feedTs = Number(msg.header?.timestamp ?? 0);
    let hasAny = false;
    for (const entity of msg.entity ?? []) {
      if (!entity.vehicle) continue;
      const vid = vehicleKey(entity);
      hasAny = true;
      const ts = entityFreshness(entity, feedTs);
      const existing = byVehicle.get(vid);
      if (!existing) {
        byVehicle.set(vid, { entity, ts, url, role });
        continue;
      }
      // Freshest wins. Strictly greater; ties resolve to whichever
      // source we saw first (primary before extras) so the merge
      // is deterministic.
      if (ts > existing.ts) {
        byVehicle.set(vid, { entity, ts, url, role });
      }
    }
    if (hasAny) sourcesWithEntities.add(url);
  }

  // 3. Build the reconciled FeedMessage. `entity` is a FeedEntity
  //    protobufjs message -- we just re-encode the array, the
  //    per-vehicle descriptor + position + trip descriptor all
  //    come along untouched. We don't try to merge subfields
  //    across sources; the freshest whole-entity wins.
  const entities: any[] = Array.from(byVehicle.values()).map((v) => v.entity);
  const reconciledMsg = FeedMessage.create({
    header: FeedHeader.create({
      gtfsRealtimeVersion: pickVersion(decoded),
      incrementality: FeedHeader.Incrementality.FULL_DATASET,
      // Wall-clock at reconcile time -- the consumer's "how fresh
      // is the served snapshot" signal, independent of source mix.
      timestamp: Math.floor(Date.now() / 1000),
    }),
    entity: entities,
  });

  const allUrls = new Set(sources.map((s) => s.url));
  const empty = Array.from(allUrls).filter(
    (u) => !failed.includes(u) && !sourcesWithEntities.has(u),
  );

  return {
    bytes: FeedMessage.encode(reconciledMsg).finish(),
    entityCount: entities.length,
    sources: Array.from(sourcesWithEntities),
    empty,
    failed,
  };
}

/** Per-vehicle merge key. Operator-assigned id when present,
 *  falling back to FeedEntity.id (some feeds don't populate
 *  the VehicleDescriptor). Returns the empty string when
 *  NEITHER is set -- the entity has no merge key, so the
 *  reconciler will include it under the empty-string bucket
 *  (best-effort dedupe; if a feed has many empty-key
 *  entities, the Map collapses them to one, but we never
 *  silently drop a position the operator paid to send). */
function vehicleKey(entity: any): string {
  return entity.vehicle.vehicle?.id ?? entity.id ?? '';
}

/** Per-vehicle freshness. Prefers the per-vehicle timestamp
 *  (which is the canonical "when was this position observed"
 *  field), falling back to the feed-level header timestamp. */
function entityFreshness(entity: any, feedTs: number): number {
  return Number(entity.vehicle.timestamp ?? feedTs ?? 0);
}

function pickVersion(decoded: Array<{ msg: any }>): string {
  const versions = new Set(
    decoded.map((d) => d.msg.header?.gtfsRealtimeVersion ?? '2.0'),
  );
  return versions.size === 1 ? Array.from(versions)[0]! : '2.0';
}
