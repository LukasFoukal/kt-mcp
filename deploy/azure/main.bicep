// Azure deployment for kt-mcp: one Container App behind Azure's managed
// HTTPS ingress, with OAuth state persisted on an Azure Files share.
//
// Deployed in two passes by deploy.sh:
//   1. imageTag empty  → registry, identity, storage, environment
//   2. imageTag set    → the Container App itself, pulling that tag
// The split exists because the image has to be built into the registry before
// the app can pull it, and it gives the AcrPull role assignment time to
// propagate before the first pull.
//
// No nginx and no Cloudflare tunnel: the Container Apps ingress terminates
// TLS and is exactly one proxy hop, which matches `trust proxy 1` in
// src/index.ts. It appends the real client IP to X-Forwarded-For, so the
// /authorize rate limiter keys on the caller, not on anything it forged.

targetScope = 'resourceGroup'

@description('Azure region for every resource.')
param location string = resourceGroup().location

@description('Container App name. Becomes the first label of the default hostname.')
@minLength(2)
@maxLength(32)
param appName string = 'kt-mcp'

@description('Image tag in the registry to run. Leave empty to deploy only the infrastructure.')
param imageTag string = ''

@description('Public HTTPS URL of the server, no path or trailing slash. Leave empty to use the Container App\'s default hostname. Set it only after binding a custom domain to the app.')
param publicUrl string = ''

@description('kaloricketabulky.cz login e-mail.')
@secure()
param ktEmail string

@description('kaloricketabulky.cz password.')
@secure()
param ktPassword string

@description('Passphrase typed on the OAuth consent page. At least 12 characters.')
@secure()
@minLength(12)
param mcpAuthPassword string

var suffix = uniqueString(resourceGroup().id)
var deployApp = !empty(imageTag)
var stateShareName = 'kt-mcp-state'
var envStorageName = 'state'
// Built-in AcrPull role.
var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'ktmcp${suffix}'
  location: location
  sku: { name: 'Basic' }
  properties: {
    // Pulls authenticate with the managed identity below, never a password.
    adminUserEnabled: false
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-identity'
  location: location
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'ktmcp${suffix}'
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

// Holds oauth-state.json: registered clients and issued tokens. Losing it
// only means re-authorizing the connector once, but it is what lets a
// redeploy keep the connector working.
resource stateShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: stateShareName
  properties: {
    shareQuota: 1
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${appName}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource environmentStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: environment
  name: envStorageName
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: stateShare.name
      accessMode: 'ReadWrite'
    }
  }
}

var defaultHostname = '${appName}.${environment.properties.defaultDomain}'
var resolvedPublicUrl = empty(publicUrl) ? 'https://${defaultHostname}' : publicUrl

resource app 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  dependsOn: [
    acrPull
  ]
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      // Single revision: a new deploy replaces the old one instead of
      // splitting traffic across two processes with separate token caches.
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8092
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
      secrets: [
        { name: 'kt-email', value: ktEmail }
        { name: 'kt-password', value: ktPassword }
        { name: 'mcp-auth-password', value: mcpAuthPassword }
      ]
    }
    template: {
      containers: [
        {
          name: 'kt-mcp'
          image: '${registry.properties.loginServer}/kt-mcp:${imageTag}'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            { name: 'KT_EMAIL', secretRef: 'kt-email' }
            { name: 'KT_PASSWORD', secretRef: 'kt-password' }
            { name: 'MCP_AUTH_PASSWORD', secretRef: 'mcp-auth-password' }
            { name: 'PUBLIC_URL', value: resolvedPublicUrl }
            { name: 'PORT', value: '8092' }
            { name: 'STATE_DIR', value: '/data' }
          ]
          volumeMounts: [
            { volumeName: 'state', mountPath: '/data' }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/healthz', port: 8092 }
              periodSeconds: 5
              failureThreshold: 12
            }
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8092 }
              periodSeconds: 30
            }
          ]
        }
      ]
      // Exactly one replica, always on. The token store is a single JSON file
      // cached in process memory (src/auth/store.ts), so a second replica
      // would overwrite it and reject tokens the first one issued. Scaling to
      // zero would add a cold start to scheduled logging and drop in-flight
      // authorization codes.
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'state'
          storageType: 'AzureFile'
          storageName: environmentStorage.name
          // SMB ignores the 0600 the store writes with, so enforce it at
          // mount time. uid 1000 is the `node` user the image runs as.
          mountOptions: 'uid=1000,gid=1000,dir_mode=0700,file_mode=0600'
        }
      ]
    }
  }
}

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output publicUrl string = resolvedPublicUrl
output mcpEndpoint string = '${resolvedPublicUrl}/mcp'
output defaultHostname string = defaultHostname
