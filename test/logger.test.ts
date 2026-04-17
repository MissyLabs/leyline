import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Logger,
  LogLevel,
  setGlobalLogLevel,
  getGlobalLogLevel,
  setGlobalLogHandler,
  type LogEntry,
} from '../src/utils/logger.js';

describe('Logger', () => {
  let captured: LogEntry[];
  let originalLevel: LogLevel;

  beforeEach(() => {
    captured = [];
    originalLevel = getGlobalLogLevel();
    setGlobalLogHandler((entry) => captured.push(entry));
    setGlobalLogLevel(LogLevel.DEBUG);
  });

  afterEach(() => {
    setGlobalLogHandler(null);
    setGlobalLogLevel(originalLevel);
  });

  it('logs messages at each level', () => {
    const log = new Logger('Test');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(captured).toHaveLength(4);
    expect(captured[0].level).toBe(LogLevel.DEBUG);
    expect(captured[1].level).toBe(LogLevel.INFO);
    expect(captured[2].level).toBe(LogLevel.WARN);
    expect(captured[3].level).toBe(LogLevel.ERROR);
  });

  it('includes component name in entries', () => {
    const log = new Logger('MyComponent');
    log.info('hello');
    expect(captured[0].component).toBe('MyComponent');
  });

  it('includes structured data', () => {
    const log = new Logger('Test');
    log.info('msg', { key: 'value', num: 42 });
    expect(captured[0].data).toEqual({ key: 'value', num: 42 });
  });

  it('entries have timestamps', () => {
    const before = Date.now();
    const log = new Logger('Test');
    log.info('hello');
    const after = Date.now();

    expect(captured[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(captured[0].timestamp).toBeLessThanOrEqual(after);
  });

  it('respects global log level — filters below threshold', () => {
    setGlobalLogLevel(LogLevel.WARN);
    const log = new Logger('Test');
    log.debug('filtered');
    log.info('filtered');
    log.warn('visible');
    log.error('visible');

    expect(captured).toHaveLength(2);
    expect(captured[0].level).toBe(LogLevel.WARN);
    expect(captured[1].level).toBe(LogLevel.ERROR);
  });

  it('SILENT level suppresses all output', () => {
    setGlobalLogLevel(LogLevel.SILENT);
    const log = new Logger('Test');
    log.debug('nope');
    log.info('nope');
    log.warn('nope');
    log.error('nope');

    expect(captured).toHaveLength(0);
  });

  it('child logger inherits parent component name', () => {
    const parent = new Logger('Parent');
    const child = parent.child('Sub');
    child.info('hello');

    expect(captured[0].component).toBe('Parent:Sub');
  });

  it('child of child nests component names', () => {
    const log = new Logger('A');
    const sub = log.child('B').child('C');
    sub.warn('deep');

    expect(captured[0].component).toBe('A:B:C');
  });

  it('data is optional — undefined when not provided', () => {
    const log = new Logger('Test');
    log.info('no data');
    expect(captured[0].data).toBeUndefined();
  });

  it('getGlobalLogLevel returns current level', () => {
    setGlobalLogLevel(LogLevel.ERROR);
    expect(getGlobalLogLevel()).toBe(LogLevel.ERROR);
  });

  it('custom handler receives all fields', () => {
    const log = new Logger('Comp');
    log.error('fail', { code: 500 });

    const entry = captured[0];
    expect(entry.level).toBe(LogLevel.ERROR);
    expect(entry.component).toBe('Comp');
    expect(entry.message).toBe('fail');
    expect(entry.data).toEqual({ code: 500 });
    expect(typeof entry.timestamp).toBe('number');
  });

  it('multiple loggers with different components are independent', () => {
    const a = new Logger('A');
    const b = new Logger('B');
    a.info('from a');
    b.info('from b');

    expect(captured[0].component).toBe('A');
    expect(captured[1].component).toBe('B');
  });

  it('setting handler to null restores default (no crash)', () => {
    setGlobalLogHandler(null);
    const log = new Logger('Test');
    // Should not throw when using the default handler
    expect(() => log.info('hello')).not.toThrow();
  });

  it('level boundary — message at exactly the threshold is included', () => {
    setGlobalLogLevel(LogLevel.WARN);
    const log = new Logger('Test');
    log.warn('boundary');
    expect(captured).toHaveLength(1);
  });

  it('level boundary — message one below threshold is excluded', () => {
    setGlobalLogLevel(LogLevel.WARN);
    const log = new Logger('Test');
    log.info('just below');
    expect(captured).toHaveLength(0);
  });
});
