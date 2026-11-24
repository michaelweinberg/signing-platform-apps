import { context, createContextKey, trace, type Attributes, type Context } from '@opentelemetry/api';

/** The two business identifiers every span and log line carries. */
export interface AgreementIds {
  agreementId: string;
  /** The caller's business identifier for the agreement, the same across every trace of it. */
  correlationId: string;
}

const AGREEMENT_KEY = createContextKey('signing-platform.agreement');

/** The name this service reports on every signal. Set per function as `OTEL_SERVICE_NAME`. */
export function serviceName(): string {
  return process.env.OTEL_SERVICE_NAME ?? 'unknown_service';
}

export function agreementAttributes({ agreementId, correlationId }: AgreementIds): Attributes {
  return { 'agreement.id': agreementId, 'correlation.id': correlationId };
}

/** Returns a context in which spans and log lines are tagged with the agreement. */
export function setAgreement(parent: Context, { agreementId, correlationId }: AgreementIds): Context {
  return parent.setValue(AGREEMENT_KEY, { agreementId, correlationId });
}

/** The agreement the given context (by default the current one) is working on, if any. */
export function currentAgreement(from: Context = context.active()): AgreementIds | undefined {
  return from.getValue(AGREEMENT_KEY) as AgreementIds | undefined;
}

/**
 * Runs `fn` on behalf of an agreement: the current span, every span started inside, and
 * every log line written inside carry its agreement ID and correlation ID.
 *
 * ```ts
 * return withAgreement(event, async () => { ... });
 * ```
 */
export function withAgreement<T>(ids: AgreementIds, fn: () => T): T {
  trace.getActiveSpan()?.setAttributes(agreementAttributes(ids));
  return context.with(setAgreement(context.active(), ids), fn);
}
