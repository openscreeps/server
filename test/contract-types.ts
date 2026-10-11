import type { ApiOperationResult } from '../src/api/operations.ts';

type Must<T extends true> = T;

// These compile-time boundaries must survive the JSON serialization compatibility mapping.
export type MissingAccountIdIsRejected = Must<
  Record<string, never> extends ApiOperationResult<'authMe'> ? false : true
>;
export type UnknownPowerClassIsRejected = Must<
  Omit<ApiOperationResult<'powerCreepsCreate'>, 'className'> & {
    className: 'warrior';
  } extends ApiOperationResult<'powerCreepsCreate'>
    ? false
    : true
>;
export type InvalidUserDictionaryIsRejected = Must<
  { objects: []; users: { bad: number } } extends ApiOperationResult<'gameRoomObjects'>
    ? false
    : true
>;
