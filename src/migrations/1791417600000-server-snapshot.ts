import { Table, type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Creates the singleton world table and the room history table. SQLite worlds written before
 * TypeORM already contain this exact world table (`CREATE TABLE IF NOT EXISTS server_snapshot
 * ...`), so an existing table is adopted as-is.
 */
export class ServerSnapshot1791417600000 implements MigrationInterface {
  readonly name = 'ServerSnapshot1791417600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'server_snapshot',
        columns: [
          { name: 'id', type: 'integer', isPrimary: true },
          { name: 'schema_version', type: 'integer' },
          { name: 'revision', type: 'bigint' },
          { name: 'state', type: 'text' },
        ],
        checks: [{ name: 'CHK_server_snapshot_singleton', expression: '"id" = 1' }],
      }),
      true,
    );
    await queryRunner.createTable(
      new Table({
        name: 'server_room_history',
        columns: [
          { name: 'room', type: 'text', isPrimary: true },
          { name: 'time', type: 'bigint', isPrimary: true },
          { name: 'objects', type: 'text' },
        ],
      }),
      true,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('server_room_history', true);
    await queryRunner.dropTable('server_snapshot', true);
  }
}
