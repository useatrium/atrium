// Metro config for the pnpm monorepo: watch the workspace root so changes in
// @atrium/surface-client hot-reload, and resolve through the isolated
// node_modules layout pnpm creates.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Workspace TS packages consumed as source (e.g. @atrium/centaur-client) use
// ESM ".js" specifiers in relative imports (export * from "./client.js"). tsc
// and Vite map those to the ".ts" source; Metro does not, so resolution fails.
// Resolve normally first, and only on failure retry a relative ".js" specifier
// with the extension stripped so Metro picks up the ".ts"/".tsx" source.
const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = baseResolveRequest ?? context.resolveRequest;
  try {
    return resolve(context, moduleName, platform);
  } catch (err) {
    if (/^\.{1,2}\//.test(moduleName) && moduleName.endsWith('.js')) {
      return resolve(context, moduleName.replace(/\.js$/, ''), platform);
    }
    throw err;
  }
};

module.exports = config;
