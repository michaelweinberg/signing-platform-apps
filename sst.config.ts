/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'signing-platform',
      home: 'aws',
      providers: {
        // Every stage lives in the same region as the Confluent Cloud cluster.
        aws: { region: 'us-west-2' },
      },
      removal: input.stage === 'demo' ? 'retain' : 'remove',
      protect: input.stage === 'demo',
    };
  },
  async run() {
    // The one shared API Gateway (HTTP API). Each service adds its own routes to it.
    const api = new sst.aws.ApiGatewayV2('Api');

    // Throwaway route: proves the deploy pipeline end to end. Remove it once a real route exists.
    api.route('GET /hello', {
      handler: 'apps/hello/src/handler.handler',
      runtime: 'nodejs24.x',
    });

    return { apiUrl: api.url };
  },
});
