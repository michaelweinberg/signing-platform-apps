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

    // Throwaway route: proves the deploy pipeline and the token checks end to end.
    // Remove it once a real route exists.
    api.route('GET /hello', {
      handler: 'apps/hello/src/handler.handler',
      runtime: 'nodejs24.x',
    });

    return {
      apiUrl: api.url,
      userPoolId: userPool.id,
      // Managed login and the token endpoint (`/oauth2/token`) are under this URL.
      authUrl: userPool.domainUrl,
      dashboardClientId: dashboardClient.id,
      salesforceClientId: salesforceClient.id,
      smokeTestClientId: smokeTestClient.id,
    };
  },
});
