import { trace } from '@opentelemetry/api';
import { SeverityNumber, logs, type AnyValueMap } from '@opentelemetry/api-logs';
import { currentAgreement, serviceName } from './telemetry-context.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const SEVERITY: Record<Level, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

/** Makes field values safe to print as JSON: an `Error` becomes its name, message, and stack. */
function plain(fields: Fields): AnyValueMap {
  return JSON.parse(
    JSON.stringify(fields, (_key, value: unknown) =>
      value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
    ),
  ) as AnyValueMap;
}

function write(level: Level, message: string, fields: Fields = {}): void {
  // Without telemetry the current span is a placeholder with an all-zero ID: leave it out.
  const active = trace.getActiveSpan()?.spanContext();
  const span = active && trace.isSpanContextValid(active) ? active : undefined;
  const agreement = currentAgreement();
  const extra = plain(fields);

  // One JSON line on stdout. On Lambda this is what CloudWatch keeps.
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      service: serviceName(),
      traceId: span?.traceId,
      spanId: span?.spanId,
      correlationId: agreement?.correlationId,
      agreementId: agreement?.agreementId,
      ...extra,
    })}\n`,
  );

  // The same event through OpenTelemetry, which is how it reaches Loki. The SDK adds the
  // trace ID and span ID from the current context. Does nothing until telemetry has started.
  logs.getLogger('signing-platform').emit({
    severityNumber: SEVERITY[level],
    severityText: level.toUpperCase(),
    body: message,
    attributes: {
      ...extra,
      ...(agreement ? { 'agreement.id': agreement.agreementId, 'correlation.id': agreement.correlationId } : {}),
    },
  });
}

/**
 * The structured logger: one JSON line per event. Every line written inside a span carries
 * its trace ID and span ID, and every line written inside `withAgreement` carries the
 * agreement ID and correlation ID.
 *
 * ```ts
 * logger.info('Envelope sent', { envelopeId });
 * ```
 */
export const logger = {
  debug: (message: string, fields?: Fields) => write('debug', message, fields),
  info: (message: string, fields?: Fields) => write('info', message, fields),
  warn: (message: string, fields?: Fields) => write('warn', message, fields),
  error: (message: string, fields?: Fields) => write('error', message, fields),
};
