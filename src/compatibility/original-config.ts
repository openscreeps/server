import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse } from 'ini';
import type { ServerConfig } from '../contracts.ts';

/** Read original launcher settings without ever treating its LokiJS file as a SQL database. */
export function originalConfig(filename: string): Partial<ServerConfig> {
  const file = resolve(filename);
  const values: Record<string, unknown> = parse(readFileSync(file, 'utf8'));
  const directory = dirname(file);
  const result: Partial<ServerConfig> = {};
  const strings = {
    host: 'host',
    password: 'serverPassword',
    steam_api_key: 'steamKey',
    cli_host: 'cliHost',
  } as const;
  for (const [source, target] of Object.entries(strings)) {
    const value = values[source];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string') throw new Error(`Invalid .screepsrc ${source}: expected text`);
    result[target] = value;
  }
  const paths = {
    assetdir: 'assetDirectory',
    modfile: 'modFile',
    logdir: 'logDirectory',
  } as const;
  for (const [source, target] of Object.entries(paths)) {
    const value = values[source];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string') throw new Error(`Invalid .screepsrc ${source}: expected a path`);
    result[target] = resolve(directory, value);
  }
  const numbers = {
    port: 'port',
    cli_port: 'cliPort',
    runners_cnt: 'runnerCount',
    runner_threads: 'runnerThreads',
    processors_cnt: 'processorCount',
    restart_interval: 'workerRestartInterval',
    log_rotate_keep: 'logRotateKeep',
  } as const;
  for (const [source, target] of Object.entries(numbers)) {
    const value = values[source];
    if (value === undefined || value === '') continue;
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) {
      throw new Error(`Invalid .screepsrc ${source}: expected a nonnegative integer`);
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number))
      throw new Error(`Invalid .screepsrc ${source}: integer out of range`);
    result[target] = number;
  }
  if (values.log_console !== undefined) {
    if (![true, false, 'true', 'false'].includes(values.log_console as boolean | string)) {
      throw new Error('Invalid .screepsrc log_console: expected true or false');
    }
    result.logConsole = values.log_console === true || values.log_console === 'true';
  }
  if (values.db !== undefined && values.db !== '') {
    if (typeof values.db !== 'string') throw new Error('Invalid .screepsrc db: expected a path');
    result.originalDatabase = resolve(directory, values.db);
    result.database = `${result.originalDatabase}.sqlite`;
  }
  return result;
}
