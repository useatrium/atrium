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
// react-syntax-highlighter@16 (security-pinned via the workspace override in
// #267) dropped the root shim files that react-native-syntax-highlighter@2
// requires ("/prism", "/styles/hljs", "/styles/prism"); the builds still exist
// under dist/cjs. Map the legacy subpaths there so Metro bundling survives the
// security pin. (jest/CI never exercise Metro resolution — only a real build
// catches this.)
// pnpm's isolated layout: react-syntax-highlighter is only resolvable through
// its consumer, so hop via react-native-syntax-highlighter.
const rnshBase = path.dirname(require.resolve('react-native-syntax-highlighter/package.json'));
const rshBase = path.dirname(
  require.resolve('react-syntax-highlighter/package.json', { paths: [rnshBase] }),
);
const RSH_LEGACY_SUBPATHS = {
  'react-syntax-highlighter/prism': path.join(rshBase, 'dist/cjs/prism.js'),
  'react-syntax-highlighter/styles/hljs': path.join(rshBase, 'dist/cjs/styles/hljs/index.js'),
  'react-syntax-highlighter/styles/prism': path.join(rshBase, 'dist/cjs/styles/prism/index.js'),
};

const baseResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = baseResolveRequest ?? context.resolveRequest;
  if (RSH_LEGACY_SUBPATHS[moduleName]) {
    return { type: 'sourceFile', filePath: RSH_LEGACY_SUBPATHS[moduleName] };
  }
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
