/**
 * setupFiles for the `react-native` jest project.
 *
 * Suites in that project load real application modules (config/firebase.ts and
 * friends), which import native-backed packages at module scope. Under jest the
 * native side does not exist, so those packages throw on import unless their
 * own shipped jest mock is registered first. Each mock below is the mock
 * published by the package itself — nothing here fakes application behaviour.
 */

// @react-native-async-storage/async-storage throws
// "[@RNC/AsyncStorage]: NativeModule: AsyncStorage is null" on import when the
// TurboModule is missing. The package ships the mock recommended by its docs.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
