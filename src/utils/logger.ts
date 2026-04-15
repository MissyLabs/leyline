export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.SILENT]: 'SILENT',
};

export interface LogEntry {
  level: LogLevel;
  component: string;
  message: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export type LogHandler = (entry: LogEntry) => void;

let globalLevel: LogLevel = LogLevel.INFO;
let globalHandler: LogHandler | null = null;

export function setGlobalLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function getGlobalLogLevel(): LogLevel {
  return globalLevel;
}

export function setGlobalLogHandler(handler: LogHandler | null): void {
  globalHandler = handler;
}

function defaultHandler(entry: LogEntry): void {
  const ts = new Date(entry.timestamp).toISOString();
  const prefix = `${ts} [${LEVEL_LABELS[entry.level]}] [${entry.component}]`;
  const suffix = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
  const line = `${prefix} ${entry.message}${suffix}`;

  switch (entry.level) {
    case LogLevel.ERROR:
      console.error(line);
      break;
    case LogLevel.WARN:
      console.warn(line);
      break;
    case LogLevel.DEBUG:
      console.debug(line);
      break;
    default:
      console.log(line);
      break;
  }
}

export class Logger {
  private readonly component: string;

  constructor(component: string) {
    this.component = component;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, data);
  }

  child(subComponent: string): Logger {
    return new Logger(`${this.component}:${subComponent}`);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (level < globalLevel) return;

    const entry: LogEntry = {
      level,
      component: this.component,
      message,
      timestamp: Date.now(),
      data,
    };

    (globalHandler ?? defaultHandler)(entry);
  }
}
