// Feature: video-transcoding-compatibility
// Unit tests for isVideoTranscodeEnabled (Requirement 8)

import { isVideoTranscodeEnabled } from '../../lib/videoTranscodeConfig';

const ENV_KEY = 'EXPO_PUBLIC_VIDEO_TRANSCODE_ENABLED';

describe('isVideoTranscodeEnabled', () => {
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
  });

  it('defaults to enabled when the env var is unset', () => {
    delete process.env[ENV_KEY];
    expect(isVideoTranscodeEnabled()).toBe(true);
  });

  it('defaults to enabled when the env var is an empty string', () => {
    process.env[ENV_KEY] = '';
    expect(isVideoTranscodeEnabled()).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'NO', 'off', 'Off', 'disabled', '  false  '])(
    'returns false for disable value "%s"',
    (value) => {
      process.env[ENV_KEY] = value;
      expect(isVideoTranscodeEnabled()).toBe(false);
    },
  );

  it.each(['true', 'TRUE', '1', 'yes', 'on', 'enabled', 'anything-else'])(
    'returns true for value "%s"',
    (value) => {
      process.env[ENV_KEY] = value;
      expect(isVideoTranscodeEnabled()).toBe(true);
    },
  );
});
