/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'signing-platform',
      home: 'aws',
      providers: {
        // Every stage lives in the same region as the Confluent Cloud cluster.
        aws: { region: 'us-west-2' },
        // Topics only. It is given no account-wide key: each topic carries the cluster's
        // own API key.
        confluentcloud: { package: '@pulumi/confluentcloud', version: '2.92.0' },
      },
      removal: input.stage === 'demo' ? 'retain' : 'remove',
      protect: input.stage === 'demo',
    };
  },
  async run() {
    // Groups, scopes, and each machine client's scopes come from the shared permission
    // mapping, so Cognito and the guard cannot disagree.
    const { groupPermissions, machineClientPermissions, permissions, resourceServer, scopeFor } = await import(
      './packages/shared/src/permissions'
    );

    // ---- Identity: one Cognito user pool per stage -------------------------------------

    const userPool = new sst.aws.CognitoUserPool('UserPool', {
      usernames: ['email'],
      mfa: 'on',
      softwareToken: true,
      // Managed login and the OAuth token endpoint live on this domain. Prefixes are
      // unique per region across all AWS accounts.
      domain: { prefix: `signing-platform-${$app.stage}` },
      transform: {
        userPool: {
          // Managed login and refresh token rotation need the Essentials plan.
          userPoolTier: 'ESSENTIALS',
          // No self sign-up: users are created by an administrator.
          adminCreateUserConfig: { allowAdminCreateUserOnly: true },
          accountRecoverySetting: { recoveryMechanisms: [{ name: 'verified_email', priority: 1 }] },
        },
        // 2 is managed login; 1 is the older hosted UI.
        domain: { managedLoginVersion: 2 },
      },
    });

    // SST's user pool component has no groups or resource servers, so these use the
    // AWS provider's resources directly.
    for (const group of Object.keys(groupPermissions)) {
      new aws.cognito.UserGroup(`UserPoolGroup-${group}`, { userPoolId: userPool.id, name: group });
    }

    const signingApi = new aws.cognito.ResourceServer('UserPoolResourceServer', {
      userPoolId: userPool.id,
      identifier: resourceServer,
      name: resourceServer,
      scopes: permissions.map((permission) => ({
        scopeName: permission,
        scopeDescription: `Grants the ${permission} permission`,
      })),
    });

    // Dashboard users: a public client, authorization code flow with PKCE.
    const dashboardClient = userPool.addClient('DashboardClient', {
      // The dashboard does not exist yet; its real URLs are added with it.
      callbackUrls: ['http://localhost:5173/callback'],
      transform: {
        client: {
          name: 'dashboard',
          generateSecret: false,
          allowedOauthFlows: ['code'],
          allowedOauthScopes: ['openid', 'email'],
          logoutUrls: ['http://localhost:5173/'],
          tokenValidityUnits: { accessToken: 'minutes', idToken: 'minutes', refreshToken: 'hours' },
          accessTokenValidity: 60,
          idTokenValidity: 60,
          refreshTokenValidity: 8,
          // Each refresh returns a new refresh token; the old one works for 10 more
          // seconds, so a retried or parallel renewal does not sign the user out.
          refreshTokenRotation: { feature: 'ENABLED', retryGracePeriodSeconds: 10 },
          explicitAuthFlows: ['ALLOW_USER_SRP_AUTH'],
          enableTokenRevocation: true,
          preventUserExistenceErrors: 'ENABLED',
        },
      },
    });

    // Managed login shows an error page for a client that has no branding style.
    new aws.cognito.ManagedLoginBranding('DashboardClientBranding', {
      userPoolId: userPool.id,
      clientId: dashboardClient.id,
      useCognitoProvidedValues: true,
    });

    // Machine callers: confidential clients, client credentials flow, their own scopes.
    const machineClient = (id: string, name: keyof typeof machineClientPermissions) =>
      userPool.addClient(
        id,
        {
          transform: {
            client: (args) => {
              args.name = name;
              args.generateSecret = true;
              args.allowedOauthFlows = ['client_credentials'];
              args.allowedOauthScopes = machineClientPermissions[name].map(scopeFor);
              // No browser is involved: no redirect, no sign-in page.
              args.callbackUrls = undefined;
              args.supportedIdentityProviders = undefined;
              args.explicitAuthFlows = [];
              args.tokenValidityUnits = { accessToken: 'minutes' };
              args.accessTokenValidity = 60;
            },
          },
        },
        // A scope must exist on the resource server before a client can be granted it.
        { dependsOn: [signingApi] },
      );
    const salesforceClient = machineClient('SalesforceClient', 'salesforce');
    const smokeTestClient = machineClient('SmokeTestClient', 'smoke-test');

    // ---- Gateway -----------------------------------------------------------------------

    // The one shared API Gateway (HTTP API). Each service adds its own routes to it.
    const api = new sst.aws.ApiGatewayV2('Api', {
      transform: {
        route: {
          // Every route requires a token unless it opts out with `auth: false`
          // (only the DocuSign webhook should: it is authenticated by HMAC signature).
          args: (route) => {
            route.auth ??= { jwt: { authorizer: authorizer.id } };
          },
        },
      },
    });

    // Checks signature, issuer, expiry, and client ID before any Lambda runs. A Cognito
    // access token has no `aud` claim; the authorizer checks `client_id` against the
    // audiences instead.
    const authorizer = api.addAuthorizer({
      name: 'cognito',
      jwt: {
        issuer: $interpolate`https://cognito-idp.${aws.getRegionOutput().region}.amazonaws.com/${userPool.id}`,
        audiences: [dashboardClient.id, salesforceClient.id, smokeTestClient.id],
      },
    });

    // ---- Telemetry ---------------------------------------------------------------------

    // Where the stage's Grafana Cloud stack accepts OTLP, and the stack's instance ID. The
    // deploy workflow sets these from the `demo` GitHub environment; a dev stage reads them
    // from `.env`. A dev stage without them deploys without the collector layer.
    const grafana = {
      endpoint: process.env.GRAFANA_OTLP_ENDPOINT,
      instanceId: process.env.GRAFANA_OTLP_INSTANCE_ID,
    };
    const hasGrafana = Boolean(grafana.endpoint && grafana.instanceId);
    if (!hasGrafana && (grafana.endpoint || grafana.instanceId || $app.stage === 'demo')) {
      throw new Error(
        'Grafana settings missing: set both GRAFANA_OTLP_ENDPOINT and GRAFANA_OTLP_INSTANCE_ID. See "Telemetry" in the README.',
      );
    }
    // A Grafana Cloud access policy token that may write traces, metrics, and logs. Set
    // once per stage from a laptop.
    const grafanaOtlpToken = hasGrafana ? new sst.Secret('GrafanaOtlpToken') : undefined;

    // The OpenTelemetry collector as a Lambda layer, published by the OpenTelemetry project.
    // `amd64` matches the functions' architecture (SST's default, x86_64).
    const collectorLayer = $interpolate`arn:aws:lambda:${aws.getRegionOutput().region}:184161586896:layer:opentelemetry-collector-amd64-0_24_0:1`;

    // Adds telemetry to a function's settings: the service name it reports, and, on a stage
    // with Grafana, the collector layer and the address the function's SDK exports to.
    // Wrap every function's settings in this.
    const instrumented = <Args extends { environment?: Record<string, $util.Input<string>> }>(service: string, args: Args) => ({
      ...args,
      environment: {
        ...args.environment,
        OTEL_SERVICE_NAME: service,
        OTEL_RESOURCE_ATTRIBUTES: `deployment.environment.name=${$app.stage}`,
        ...(hasGrafana
          ? {
              // The collector layer, listening inside the function's own sandbox.
              OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
              OPENTELEMETRY_COLLECTOR_CONFIG_URI: '/var/task/collector.yaml',
              GRAFANA_OTLP_ENDPOINT: grafana.endpoint!,
              GRAFANA_OTLP_INSTANCE_ID: grafana.instanceId!,
              GRAFANA_OTLP_TOKEN: grafanaOtlpToken!.value,
            }
          : {}),
      },
      ...(hasGrafana
        ? {
            layers: [collectorLayer],
            copyFiles: [{ from: 'packages/shared/collector.yaml', to: 'collector.yaml' }],
          }
        : {}),
    });

    // Throwaway route: proves the deploy pipeline and the token checks end to end.
    // Remove it once a real route exists.
    api.route(
      'GET /hello',
      instrumented('hello', {
        handler: 'apps/hello/src/handler.handler',
        runtime: 'nodejs24.x',
      }),
    );

    // ---- Kafka -------------------------------------------------------------------------

    // Where the stage's Confluent Cloud cluster is, and the admin API key that creates its
    // topics. The deploy workflow sets these from the `demo` GitHub environment; a dev
    // stage reads them from `.env`. A dev stage without them deploys without Kafka.
    const confluent = {
      clusterId: process.env.CONFLUENT_CLUSTER_ID,
      restEndpoint: process.env.CONFLUENT_REST_ENDPOINT,
      bootstrapServers: process.env.CONFLUENT_BOOTSTRAP_SERVERS,
      apiKey: process.env.CONFLUENT_CLUSTER_API_KEY,
      apiSecret: process.env.CONFLUENT_CLUSTER_API_SECRET,
      schemaRegistryUrl: process.env.SCHEMA_REGISTRY_URL,
    };
    const unset = Object.entries(confluent).filter(([, value]) => !value);
    const hasKafka = unset.length === 0;
    if (!hasKafka && (unset.length < Object.keys(confluent).length || $app.stage === 'demo')) {
      throw new Error(
        `Confluent settings missing: ${unset.map(([name]) => name).join(', ')}. See "Kafka" in the README.`,
      );
    }

    let publishEventFunction: $util.Output<string> | undefined;

    if (hasKafka) {
      const { EVENT_CATALOGUE } = await import('./packages/shared/src/generated/events');

      // One topic per producing service, named in the event catalogue.
      for (const topic of new Set(Object.values(EVENT_CATALOGUE).map(({ topic }) => topic))) {
        new confluentcloud.KafkaTopic(`KafkaTopic-${topic}`, {
          kafkaCluster: { id: confluent.clusterId! },
          restEndpoint: confluent.restEndpoint!,
          credentials: { key: confluent.apiKey!, secret: $util.secret(confluent.apiSecret!) },
          topicName: topic,
          partitionsCount: 3,
        });
      }

      // What a running service connects with. Set once per stage from a laptop; the
      // pipeline never sees these, and they are not the admin key above.
      const kafkaApiKey = new sst.Secret('KafkaApiKey');
      const kafkaApiSecret = new sst.Secret('KafkaApiSecret');
      const schemaRegistryApiKey = new sst.Secret('SchemaRegistryApiKey');
      const schemaRegistryApiSecret = new sst.Secret('SchemaRegistryApiSecret');

      // The environment `kafkaClientsFromEnv` in the shared package reads.
      const kafkaEnvironment = {
        KAFKA_BOOTSTRAP_SERVERS: confluent.bootstrapServers!,
        KAFKA_API_KEY: kafkaApiKey.value,
        KAFKA_API_SECRET: kafkaApiSecret.value,
        SCHEMA_REGISTRY_URL: confluent.schemaRegistryUrl!,
        SCHEMA_REGISTRY_API_KEY: schemaRegistryApiKey.value,
        SCHEMA_REGISTRY_API_SECRET: schemaRegistryApiSecret.value,
      };

      // Throwaway: one function writes an event to an outbox, and the relay publishes it.
      // Proves the outbox reaches Confluent Cloud from a deployed stage. Remove the table
      // and both functions once a real service publishes.
      const publishEventTable = new sst.aws.Dynamo('PublishEventTable', {
        fields: { PK: 'string' },
        primaryIndex: { hashKey: 'PK' },
        stream: 'new-image',
      });

      publishEventTable.subscribe(
        'PublishEventRelay',
        instrumented('publish-event', {
          handler: 'apps/publish-event/src/relay.handler',
          runtime: 'nodejs24.x',
          timeout: '30 seconds',
          environment: kafkaEnvironment,
        }),
        { filters: [{ eventName: ['INSERT'] }] },
      );

      const publishEvent = new sst.aws.Function(
        'PublishEvent',
        instrumented('publish-event', {
          handler: 'apps/publish-event/src/publish.handler',
          runtime: 'nodejs24.x',
          environment: { TABLE_NAME: publishEventTable.name },
          permissions: [{ actions: ['dynamodb:PutItem'], resources: [publishEventTable.arn] }],
        }),
      );
      publishEventFunction = publishEvent.name;
    }

    return {
      apiUrl: api.url,
      userPoolId: userPool.id,
      // Managed login and the token endpoint (`/oauth2/token`) are under this URL.
      authUrl: userPool.domainUrl,
      dashboardClientId: dashboardClient.id,
      salesforceClientId: salesforceClient.id,
      smokeTestClientId: smokeTestClient.id,
      // Invoke this to publish one event through the outbox. Absent on a stage without Kafka.
      publishEventFunction,
    };
  },
});
