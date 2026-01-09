// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
// Exclude sensitive files from the JS bundle
const exclusionList = require('metro-config/src/defaults/exclusionList');
const { resolve } = require('metro-resolver');
const path = require('path');

/** @type {import('expo/metro-config').MetroConfig} */
const baseConfig = getDefaultConfig(__dirname);

// Prevent bundling of service account keys or other sensitive local scripts
baseConfig.resolver.blockList = exclusionList([
	/serviceAccountKey\.json$/,
	/scripts\/serviceAccountKey\.json$/,
]);

// Add asset extensions for favicon handling
baseConfig.resolver.assetExts = [...baseConfig.resolver.assetExts, 'ico', 'svg'];

// Web-specific configuration for static assets
baseConfig.transformer.assetPlugins = ['expo-asset/tools/hashAssetFiles'];

// Wrap with NativeWind first; it may override resolver settings.
const config = withNativeWind(baseConfig, { input: './global.css' });

// Enable web platform resolution (e.g. *.web.tsx).
config.resolver.platforms = Array.from(
	new Set([...(config.resolver.platforms || []), 'web']),
);

// Ensure web bundles use react-native-web instead of react-native.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
	if (platform === 'web') {
		// Safety net: if a React Native internal file is ever pulled into a web bundle,
		// its own relative requires (./foo, ../bar) will often point at modules that only
		// exist for ios/android. Stub those relative requires so web bundling can proceed.
		if (
			typeof context?.originModulePath === 'string'
			&& context.originModulePath.includes('node_modules/react-native/Libraries/')
			&& (moduleName.startsWith('./') || moduleName.startsWith('../'))
		) {
			return {
				type: 'sourceFile',
				filePath: path.resolve(
					__dirname,
					'web/metro-stubs/reactNativeLibrariesStub.js',
				),
			};
		}

		// react-native's processColor.js requires '../Utilities/Platform' (relative).
		// On web, react-native does not provide Platform.web.js, so if this native file
		// gets pulled into the bundle we stub Platform just enough to proceed.
		if (
			moduleName === '../Utilities/Platform'
			&& typeof context?.originModulePath === 'string'
			&& context.originModulePath.includes(
				'react-native/Libraries/StyleSheet/processColor',
			)
		) {
			return {
				type: 'sourceFile',
				filePath: path.resolve(__dirname, 'web/metro-stubs/rnPlatform.js'),
			};
		}

		// PlatformBaseViewConfig.js imports './BaseViewConfig' relatively.
		// When a dependency accidentally pulls this RN internal into a web bundle,
		// Metro will try to resolve the relative module name (not the full path).
		if (
			moduleName === './BaseViewConfig'
			&& typeof context?.originModulePath === 'string'
			&& context.originModulePath.includes(
				'react-native/Libraries/NativeComponent/PlatformBaseViewConfig',
			)
		) {
			return {
				type: 'sourceFile',
				filePath: path.resolve(
					__dirname,
					'web/metro-stubs/reactNativeLibrariesStub.js',
				),
			};
		}

		// Some native-only libraries reference React Native internals.
		// Provide minimal web stubs so Metro can bundle without pulling in react-native internals.
		if (
			moduleName === 'react-native/Libraries/StyleSheet/processColor'
			|| moduleName === 'react-native/Libraries/StyleSheet/processColor.js'
		) {
			return {
				type: 'sourceFile',
				filePath: path.resolve(__dirname, 'web/metro-stubs/processColor.js'),
			};
		}
		if (
			moduleName === 'react-native/Libraries/Image/resolveAssetSource'
			|| moduleName === 'react-native/Libraries/Image/resolveAssetSource.js'
		) {
			return {
				type: 'sourceFile',
				filePath: path.resolve(
					__dirname,
					'web/metro-stubs/resolveAssetSource.js',
				),
			};
		}
		if (moduleName === 'react-native/Libraries/NativeComponent/PlatformBaseViewConfig') {
			return {
				type: 'sourceFile',
				filePath: path.resolve(
					__dirname,
					'web/metro-stubs/reactNativeLibrariesStub.js',
				),
			};
		}
		if (moduleName === 'react-native/Libraries/NativeComponent/BaseViewConfig') {
			return {
				type: 'sourceFile',
				filePath: path.resolve(
					__dirname,
					'web/metro-stubs/reactNativeLibrariesStub.js',
				),
			};
		}

		if (moduleName === 'react-native') {
			return defaultResolveRequest
				? defaultResolveRequest(context, 'react-native-web', platform)
				: resolve(context, 'react-native-web', platform);
		}
	}

	return defaultResolveRequest
		? defaultResolveRequest(context, moduleName, platform)
		: resolve(context, moduleName, platform);
};

module.exports = config;
