import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from './world-snapshot.entity.ts';

/**
 * One committed room history frame (`state.history[room]` entry at tick `time`). Frames are never
 * changed once recorded: commits insert new frames and delete expired or replaced ones.
 */
@Entity({ name: 'server_room_history' })
export class RoomHistoryFrame {
  @PrimaryColumn({ type: 'text' })
  room!: string;

  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  time!: number;

  /** JSON of the frame's room objects, keyed by object id. */
  @Column({ type: 'text' })
  objects!: string;
}
