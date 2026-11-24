import { marshall } from '@aws-sdk/util-dynamodb';
import type { SchemaRegistry } from '@kafkajs/confluent-schema-registry';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import type { ProducerBatch } from 'kafkajs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { EnvelopeSent } from './generated/events.js';
import { logger } from './logger.js';
import { createOutboxRelay, outboxPut } from './outbox.js';
import { flushTelemetry, startTelemetry, withTelemetry } from './telemetry.js';
import { withAgreement } from './telemetry-context.js';

const spans = new InMemorySpanExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const logRecords = new InMemoryLogRecordExporter();

vi.stubEnv('OTEL_SERVICE_NAME', 'signing-service');
startTelemetry({
  spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
  metricReaders: [new PeriodicExportingMetricReader({ exporter: metricExporter })],
  logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: logRecords })],
});

const event: EnvelopeSent = {
  eventId: '0b0e7c1c-51a5-4a55-9d0b-0d3a5f1f6a01',
  eventType: 'envelope.sent',
  eventVersion: 1,
  occurredAt: 1_794_000_000_000,
  agreementId: '5f3c2c56-6a55-4b43-8f0e-7a4f0f0f2b02',
  correlationId: 'OPP-0001',
  envelopeId: 'env-1',
  sentAt: 1_794_000_000_500,
};

const registry = {
  getRegistryIdBySchema: () => Promise.resolve(7),
  encode: (id: number, payload: unknown) => Promise.resolve(Buffer.from(`${id}:${JSON.stringify(payload)}`)),
} as unknown as SchemaRegistry;

const insert = (item: Record<string, unknown>) => ({
  eventName: 'INSERT',
  dynamodb: { NewImage: marshall(item) },
});

let stdout: string[];

beforeEach(() => {
  spans.reset();
  logRecords.reset();
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((line) => {
    stdout.push(String(line));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const logLines = () => stdout.map((line) => JSON.parse(line) as Record<string, unknown>);
const spanNamed = (name: string) => spans.getFinishedSpans().find((span) => span.name === name)!;

/** Runs a handler that writes an outbox item, then the relay on that item, as two invocations. */
async function writeThenRelay(
  options: { headers?: Record<string, string>; sendBatch?: () => Promise<never[]> } = {},
) {
  let item: Record<string, unknown> = {};
  const handler = withTelemetry<[{ headers?: Record<string, string> }], void>(() =>
    withAgreement(event, () => {
      item = outboxPut('EnvelopeSent', event, { tableName: 'signing' }).Put!.Item!;
      logger.info('Envelope sent', { envelopeId: event.envelopeId });
      return Promise.resolve();
    }),
  );
  await handler({ headers: options.headers });

  const batches: ProducerBatch[] = [];
  const relay = withTelemetry(
    createOutboxRelay({
      registry,
      producer: {
        sendBatch: (batch) => {
          batches.push(batch);
          return options.sendBatch?.() ?? Promise.resolve([]);
        },
      },
    }),
  );
  const relayed = relay({ Records: [insert(item)] });
  return { item, batches, relayed };
}

test('the handler, the relay, and the Kafka send are one trace across the outbox', async () => {
  const { item, batches, relayed } = await writeThenRelay();
  await relayed;

  const handlerSpan = spanNamed('signing-service');
  const relaySpan = spanNamed('outbox relay');
  const sendSpan = spanNamed('send envelopes');
  const { traceId } = handlerSpan.spanContext();

  expect(item.traceparent).toBe(`00-${traceId}-${handlerSpan.spanContext().spanId}-01`);
  expect(relaySpan.spanContext().traceId).toBe(traceId);
  expect(relaySpan.parentSpanContext?.spanId).toBe(handlerSpan.spanContext().spanId);
  expect(sendSpan.spanContext().traceId).toBe(traceId);
  expect(sendSpan.parentSpanContext?.spanId).toBe(relaySpan.spanContext().spanId);
  expect(sendSpan.kind).toBe(SpanKind.PRODUCER);

  // The relay's own invocation is a separate trace, linked from the relay span.
  const invocation = spans.getFinishedSpans().filter((span) => span.name === 'signing-service')[1]!;
  expect(invocation.spanContext().traceId).not.toBe(traceId);
  expect(relaySpan.links.map((link) => link.context.spanId)).toEqual([invocation.spanContext().spanId]);

  const message = batches[0]!.topicMessages![0]!.messages[0]!;
  expect(message.headers).toEqual({
    traceparent: `00-${traceId}-${sendSpan.spanContext().spanId}-01`,
    tracestate: expect.stringMatching(/^ot=th:0/) as string,
  });
});

test("a request that carries traceparent continues the caller's trace and keeps its tracestate", async () => {
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const { batches, relayed } = await writeThenRelay({
    headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01`, tracestate: 'vendor=abc' },
  });
  await relayed;

  expect(spanNamed('signing-service').parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
  const { headers } = batches[0]!.topicMessages![0]!.messages[0]!;
  expect(headers?.traceparent).toMatch(new RegExp(`^00-${traceId}-`));
  expect(headers?.tracestate).toBe('vendor=abc');
});

test('every span of the trace carries the agreement ID and the correlation ID', async () => {
  await (await writeThenRelay()).relayed;

  for (const name of ['signing-service', 'outbox relay', 'send envelopes']) {
    expect(spanNamed(name).attributes).toMatchObject({
      'agreement.id': event.agreementId,
      'correlation.id': event.correlationId,
    });
  }
});

test('every log line carries the trace ID, span ID, correlation ID, and agreement ID', async () => {
  await (await writeThenRelay()).relayed;

  const lines = logLines();
  expect(lines.map((line) => line.message)).toEqual(['Envelope sent', 'Published event']);
  const [handlerSpan, relaySpan] = [spanNamed('signing-service'), spanNamed('outbox relay')];
  for (const [index, span] of [handlerSpan, relaySpan].entries()) {
    expect(lines[index]).toMatchObject({
      level: 'info',
      service: 'signing-service',
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      correlationId: event.correlationId,
      agreementId: event.agreementId,
    });
  }

  // The same lines as OpenTelemetry log records, which is how they reach Loki.
  const records = logRecords.getFinishedLogRecords();
  expect(records.map((record) => record.body)).toEqual(['Envelope sent', 'Published event']);
  expect(records[1]!.spanContext?.spanId).toBe(relaySpan.spanContext().spanId);
  expect(records[1]!.attributes).toMatchObject({
    'agreement.id': event.agreementId,
    'correlation.id': event.correlationId,
    topic: 'envelopes',
  });
});

test('publishing counts the event and records the relay delay, with bounded labels', async () => {
  metricExporter.reset();
  await (await writeThenRelay()).relayed;
  await flushTelemetry();

  const metricsByName = new Map<string, MetricData>();
  for (const { scopeMetrics } of metricExporter.getMetrics()) {
    for (const metric of scopeMetrics.flatMap((scope) => scope.metrics)) {
      metricsByName.set(metric.descriptor.name, metric);
    }
  }

  const published = metricsByName.get('events_published_total')!;
  expect(published.dataPoints.map((point) => point.attributes)).toEqual([
    { service: 'signing-service', topic: 'envelopes', event_type: 'EnvelopeSent' },
  ]);

  const delay = metricsByName.get('outbox_relay_delay_ms')!;
  expect(delay.dataPoints.map((point) => point.attributes)).toEqual([{ service: 'signing-service' }]);
  expect((delay.dataPoints[0]!.value as { count: number }).count).toBeGreaterThan(0);
});

test('a failed send marks the trace as failed and still fails the batch', async () => {
  const { relayed } = await writeThenRelay({ sendBatch: () => Promise.reject(new Error('broker down')) });
  await expect(relayed).rejects.toThrow('broker down');

  expect(spanNamed('send envelopes').status.code).toBe(SpanStatusCode.ERROR);
  expect(spanNamed('outbox relay').status.code).toBe(SpanStatusCode.ERROR);
  expect(logLines().at(-1)).toMatchObject({ level: 'error', message: 'Handler failed', error: { message: 'broker down' } });
});
