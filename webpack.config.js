const path = require('path');
const webpack = require('webpack');

const createExpoWebpackConfigAsync = require('@expo/webpack-config');

module.exports = async function (env, argv) {
  // Ensure Expo Router resolves the app directory correctly on web.
  // Must be set before @expo/webpack-config builds plugins.
  process.env.EXPO_ROUTER_APP_ROOT = path.resolve(__dirname, 'app');

  const config = await createExpoWebpackConfigAsync(env, argv);

  // Expo Router relies on EXPO_ROUTER_APP_ROOT for require.context().
  // When this resolves incorrectly, web bundling fails with "Can't resolve '../../../../../../app'".
  config.plugins = config.plugins || [];
  config.plugins.push(
    new webpack.DefinePlugin({
      'process.env.EXPO_ROUTER_APP_ROOT': JSON.stringify(path.resolve(__dirname, 'app')),
    }),
  );

  return config;
};
