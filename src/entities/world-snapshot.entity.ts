import { Column, Entity, PrimaryColumn, type ValueTransformer } from 'typeorm';

/** PostgreSQL returns BIGINT as a string; SQLite returns a number. Both map to a safe integer. */
export const bigintTransformer: ValueTransformer = {
  to: (value: unknown) => value,
  from: (value: unknown) => (typeof value === 'string' ? Number(value) : value),
};

/**
 * The single durable world row (`id = 1`). The world, runtime and scheduler metadata form one JSON
 * snapshot because the engine requires them to commit atomically together. Room history only grows
 * and expires, so its frames are rows of their own (`RoomHistoryFrame`), written in the same
 * transaction, and the snapshot's `history` is empty. `revision` counts commits and guards every
 * update against a writer that does not hold this server's lease.
 */
@Entity({ name: 'server_snapshot' })
export class WorldSnapshot {
  @PrimaryColumn({ type: 'integer' })
  id!: number;

  @Column({ name: 'schema_version', type: 'integer' })
  schemaVersion!: number;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  revision!: number;

  @Column({ type: 'text' })
  state!: string;
}
