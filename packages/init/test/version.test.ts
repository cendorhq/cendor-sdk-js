import { describe, expect, it } from 'vitest';
import { cleanVersion, compareVersions, rangeBlocksLatest } from '../src/version.js';

describe('cleanVersion', () => {
  it('strips range operators', () => {
    expect(cleanVersion('^0.1.0')).toBe('0.1.0');
    expect(cleanVersion('>=1.3,<2')).toBe('1.3');
    expect(cleanVersion('~1.2.3')).toBe('1.2.3');
    expect(cleanVersion('*')).toBe(null);
  });
});

describe('compareVersions', () => {
  it('orders correctly with missing parts', () => {
    expect(compareVersions('1.2.0', '1.2')).toBe(0);
    expect(compareVersions('0.1.0', '0.5.0')).toBe(-1);
    expect(compareVersions('1.5.0', '1.4.1')).toBe(1);
  });
});

describe('rangeBlocksLatest — honest: only true when latest is provably excluded', () => {
  it('caret on 0.x locks the minor → blocks a newer minor', () => {
    expect(rangeBlocksLatest('^0.1.0', '0.5.0')).toBe(true);
    expect(rangeBlocksLatest('^0.5.0', '0.5.0')).toBe(false);
    expect(rangeBlocksLatest('^0.5.0', '0.6.0')).toBe(true);
  });

  it('caret on >=1.x allows any newer minor within the major', () => {
    expect(rangeBlocksLatest('^1.0.6', '1.0.6')).toBe(false);
    expect(rangeBlocksLatest('^1.0.0', '1.9.0')).toBe(false);
    expect(rangeBlocksLatest('^1.0.0', '2.0.0')).toBe(true);
  });

  it('open-ended >= never blocks (latest is reachable)', () => {
    expect(rangeBlocksLatest('>=1.3,<2', '1.5.0')).toBe(false);
    expect(rangeBlocksLatest('>=1.0', '9.9.9')).toBe(false);
    expect(rangeBlocksLatest('*', '9.9.9')).toBe(false);
  });

  it('an upper bound that excludes latest blocks', () => {
    expect(rangeBlocksLatest('>=1.0,<1.4', '1.5.0')).toBe(true);
    expect(rangeBlocksLatest('<=1.4.0', '1.5.0')).toBe(true);
  });

  it('an exact pin below latest blocks', () => {
    expect(rangeBlocksLatest('1.0.0', '1.5.0')).toBe(true);
    expect(rangeBlocksLatest('==1.0.0', '1.5.0')).toBe(true);
    expect(rangeBlocksLatest('1.5.0', '1.5.0')).toBe(false);
  });
});
