import { Module, type DynamicModule } from '@nestjs/common';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { ServerConfig } from './contracts.ts';
import { dataSourceOptions } from './database.ts';
import { StateStore } from './services/state-store.service.ts';

/**
 * World persistence for the Nest application. Nest owns the TypeORM data source and destroys it on
 * application shutdown, after the kernel closed the exported StateStore in `onModuleDestroy`. The
 * store opens while providers are created, so a world owned by another server, or a malformed
 * one, fails application creation.
 */
@Module({})
export class PersistenceModule {
  static register(config: ServerConfig): DynamicModule {
    return {
      module: PersistenceModule,
      imports: [
        TypeOrmModule.forRoot({
          ...dataSourceOptions(config),
          // Retry connecting to a networked database only; a locked SQLite file refuses at once.
          toRetry: () => config.databaseUrl !== undefined,
        }),
      ],
      providers: [
        {
          provide: StateStore,
          inject: [getDataSourceToken()],
          useFactory: async (dataSource: DataSource): Promise<StateStore> => {
            try {
              return await StateStore.open(dataSource);
            } catch (error) {
              // Nest never shuts down an application that failed to create; release the world here.
              try {
                if (dataSource.isInitialized) await dataSource.destroy();
              } catch (cleanup) {
                throw new AggregateError(
                  [error, cleanup],
                  'World store failed to open and to close',
                  { cause: cleanup },
                );
              }
              throw error;
            }
          },
        },
      ],
      exports: [StateStore],
    };
  }
}
