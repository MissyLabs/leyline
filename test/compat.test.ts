import { describe, it, expect } from 'vitest';
import { semverGte, semverLt, checkCompat } from '../src/config/compat.js';

describe('semverGte / semverLt', () => {
  it('equal versions are gte', () => {
    expect(semverGte('1.2.3', '1.2.3')).toBe(true);
  });

  it('higher major is gte', () => {
    expect(semverGte('2.0.0', '1.9.9')).toBe(true);
  });

  it('lower major is not gte', () => {
    expect(semverGte('0.9.9', '1.0.0')).toBe(false);
  });

  it('higher minor is gte', () => {
    expect(semverGte('1.3.0', '1.2.9')).toBe(true);
  });

  it('higher patch is gte', () => {
    expect(semverGte('1.2.4', '1.2.3')).toBe(true);
  });

  it('semverLt is inverse of semverGte', () => {
    expect(semverLt('0.1.0', '0.2.0')).toBe(true);
    expect(semverLt('0.2.0', '0.1.0')).toBe(false);
    expect(semverLt('1.0.0', '1.0.0')).toBe(false);
  });

  it('malformed version parses as 0.0.0', () => {
    expect(semverGte('not-a-version', '0.0.0')).toBe(true);
    expect(semverGte('not-a-version', '0.0.1')).toBe(false);
  });

  it('version with pre-release suffix parses correctly', () => {
    expect(semverGte('1.2.3-beta', '1.2.3')).toBe(true);
    expect(semverGte('1.2.3-beta', '1.2.4')).toBe(false);
  });
});

describe('checkCompat', () => {
  it('empty version is incompatible', () => {
    const result = checkCompat('');
    expect(result.compatible).toBe(false);
    expect(result.message).toContain('Unknown');
  });

  it('version 0.0.0 is incompatible', () => {
    const result = checkCompat('0.0.0');
    expect(result.compatible).toBe(false);
  });

  it('version below minVersion is incompatible', () => {
    const result = checkCompat('0.0.9');
    expect(result.compatible).toBe(false);
    expect(result.message).toContain('below minimum');
  });

  it('version equal to minVersion is compatible', () => {
    const result = checkCompat('0.1.0');
    expect(result.compatible).toBe(true);
  });

  it('deprecated version is compatible with deprecation flag', () => {
    const result = checkCompat('0.1.0');
    expect(result.compatible).toBe(true);
    expect(result.deprecated).toBe(true);
  });

  it('current version is fully compatible', () => {
    const result = checkCompat('0.2.0');
    expect(result.compatible).toBe(true);
    expect(result.deprecated).toBe(false);
    expect(result.message).toBe('OK');
  });

  it('version newer than current is fully compatible', () => {
    const result = checkCompat('9.9.9');
    expect(result.compatible).toBe(true);
    expect(result.deprecated).toBe(false);
  });
});
