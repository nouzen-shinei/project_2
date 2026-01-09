module.exports = function(api) {
  const isProd = api.env('production');
  const isWeb = api.caller((caller) => caller && caller.platform === 'web');
  const disableLogs = process.env.EXPO_PUBLIC_DISABLE_LOGS === '1' || process.env.EXPO_PUBLIC_DISABLE_LOGS === 'true';
  // Cache based on the two inputs that affect config output
  api.cache(() => `${isProd ? 'prod' : 'dev'}-${disableLogs ? 'nologs' : 'logs'}-${isWeb ? 'web' : 'native'}`);

  const plugins = [
    // Ensure RN imports resolve correctly on web (Metro web bundler).
    ...(isWeb ? ['react-native-web'] : []),
    [
      'module-resolver',
      {
        root: ['./'],
        alias: {
          '@': './',
        },
      }
    ]
  ];

  // Only strip consoles when the explicit disable flag is set; rely on runtime/logger otherwise.
  if (disableLogs) {
    plugins.push(['transform-remove-console', { exclude: ['error'] }]);
  }

  return {
    presets: ['babel-preset-expo'],
    plugins,
  };
};
