import { Column, Entity, PrimaryColumn, type ValueTransformer } from 'typeorm';

/** PostgreSQL returns BIGINT as a string; SQLite returns a number. Both map to a safe integer. */
const revisionTransformer: ValueTransformer = {
  to: (value: unknown) => value,
  from: (value: unknown) => (typeof value === 'string' ? Number(value) : value),
};

/**
 * The single durable world row (`id = 1`). The whole world, runtime and scheduler metadata form one
 * JSON snapshot because the engine requires them to commit atomically together; `revision` counts
 * commits and guards every update against a writer that does not hold this server's lease.
 */
@Entity({ name: 'server_snapshot' })
export class WorldSnapshot {
  @PrimaryColumn({ type: 'integer' })
  id!: number;

  @Column({ name: 'schema_version', type: 'integer' })
  schemaVersion!: number;

  @Column({ type: 'bigint', transformer: revisionTransformer })
  revision!: number;

  @Column({ type: 'text' })
  state!: string;
}
