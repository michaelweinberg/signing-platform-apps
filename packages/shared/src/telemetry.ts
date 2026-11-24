import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  metrics,
  propagation,
  trace,
  type Context,
} from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
  serviceInstanceIdDetector,
} from '@opentelemetry/resources';
import {
  createComposableAlwaysOnSampler,
  createComposableParentThresholdSampler,
  createCompositeSampler,
} from '@opentelemetry/sampler-composite';
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { MeterProvider, PeriodicExportingMetricReader, type IMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, TracerProvider, type SpanProcessor } from '@opentelemetry/sdk-trace';
import { logger } from './logger.js';
import { agreementAttributes, currentAgreement, serviceName } from './telemetry-context.js';

/** Where telemetry is sent instead of the OTLP endpoint. For tests. */
export interface TelemetryDestinations {
  spanProcessors: SpanProcessor[];
  metricReaders: IMetricReader[];
  logRecordProcessors: LogRecordProcessor[];
}

/** Tags every span started on behalf of an agreement with its two identifiers. */
const agreementSpanProcessor: SpanProcessor = {
  onStart(span, parentContext) {
    const agreement = currentAgreement(parentContext);
    if (agreement) span.setAttributes(agreementAttributes(agreement));
  },
  onEnd: () => undefined,
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

function otlpDestinations(): TelemetryDestinations {
  // Each exporter reads `OTEL_EXPORTER_OTLP_ENDPOINT` and adds its own path.
  return {
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  };
}

let started = false;
let flushes: (() => Promise<unknown>)[] = [];

/**
 * Starts OpenTelemetry for this process. Safe to call more than once; only the first call
 * does anything. `withTelemetry` calls it, so a Lambda handler never needs to.
 *
 * Signals are exported over OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT`: the collector Lambda
 * layer on a deployed stage, Grafana's all-in-one container locally. Without that variable
 * nothing is exported: spans are not recorded and no metric is kept. Log lines are still
 * written to stdout, with their agreement and correlation IDs.
 */
export function startTelemetry(destinations?: TelemetryDestinations): void {
  if (started) return;
  started = true;

  // Needed even when nothing is exported: `withAgreement` relies on it.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  // `traceparent` and `tracestate` only. No baggage: nothing but trace context crosses a hop.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  const exporting = process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.OTEL_SDK_DISABLED !== 'true';
  if (!destinations && !exporting) return;
  const { spanProcessors, metricReaders, logRecordProcessors } = destinations ?? otlpDestinations();

  // `service.name` and anything in `OTEL_RESOURCE_ATTRIBUTES`, plus a random instance ID.
  // Without the instance ID, two copies of a Lambda would report the same cumulative
  // counter as one series and overwrite each other.
  const resource = defaultResource()
    .merge(detectResources({ detectors: [envDetector, serviceInstanceIdDetector] }))
    .merge(resourceFromAttributes({ 'service.name': serviceName() }));

  const tracerProvider = new TracerProvider({
    resource,
    // Sample everything, unless the caller's `traceparent` says the trace is not sampled.
    // This sampler also records its decision in `tracestate` (`ot=th:0`: 100% sampled),
    // so the trace state is never empty and travels with `traceparent`.
    sampler: createCompositeSampler(createComposableParentThresholdSampler(createComposableAlwaysOnSampler())),
    spanProcessors: [agreementSpanProcessor, ...spanProcessors],
  });
  const meterProvider = new MeterProvider({ resource, readers: metricReaders });
  const loggerProvider = new LoggerProvider({ resource, processors: logRecordProcessors });

  trace.setGlobalTracerProvider(tracerProvider);
  metrics.setGlobalMeterProvider(meterProvider);
  logs.setGlobalLoggerProvider(loggerProvider);
  flushes = [
    () => tracerProvider.forceFlush(),
    () => meterProvider.forceFlush(),
    () => loggerProvider.forceFlush(),
  ];
}

/**
 * Sends everything recorded so far to the exporter. Never throws: a telemetry failure
 * must not fail the work it describes.
 */
export async function flushTelemetry(): Promise<void> {
  await Promise.allSettled(flushes.map((flush) => flush()));
}

let coldStart = true;

/** The trace an HTTP caller is already in, from its `traceparent` header. */
function callerContext(event: unknown): Context {
  const headers = (event as { headers?: unknown } | undefined)?.headers;
  return headers && typeof headers === 'object' ? propagation.extract(ROOT_CONTEXT, headers) : ROOT_CONTEXT;
}

/**
 * Wraps a Lambda handler so each invocation is a span, and everything it recorded has been
 * handed to the collector layer before Lambda freezes the function. Wrap every handler:
 *
 * ```ts
 * export const handler = withTelemetry(async (event) => { ... });
 * ```
 *
 * An HTTP request that carries a `traceparent` header continues the caller's trace. A
 * thrown error is logged, marks the span as failed, and is thrown again.
 */
export function withTelemetry<Args extends unknown[], Result>(
  handler: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  startTelemetry();

  return (...args) =>
    trace.getTracer('signing-platform').startActiveSpan(
      process.env.AWS_LAMBDA_FUNCTION_NAME ?? serviceName(),
      { kind: SpanKind.SERVER, attributes: { 'faas.coldstart': coldStart } },
      callerContext(args[0]),
      async (span) => {
        coldStart = false;
        try {
          const result = await handler(...args);
          const status = (result as { statusCode?: unknown } | undefined)?.statusCode;
          if (typeof status === 'number') {
            span.setAttribute('http.response.status_code', status);
            if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
          }
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : undefined });
          logger.error('Handler failed', { error });
          throw error;
        } finally {
          span.end();
          await flushTelemetry();
        }
      },
    );
}
