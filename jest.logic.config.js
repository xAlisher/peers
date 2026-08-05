// Pure-logic unit tests (#49) that don't need the React Native runtime — the
// @react-native/jest-preset pulls in native mocks and isn't installed for CI's
// lightweight logic run. These cover the wire-contract + store reducers that
// are the most regression-prone (hex codec, conversation ordering/labelling).
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(t|j)sx?$': [
      'babel-jest',
      {presets: ['module:@react-native/babel-preset']},
    ],
  },
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__tests__/support/react-native-stub.js',
  },
  testMatch: [
    '<rootDir>/__tests__/address.test.ts',
    '<rootDir>/__tests__/addressPayload.test.ts',
    '<rootDir>/__tests__/chatStore.logic.test.ts',
    '<rootDir>/__tests__/relay.test.ts',
    '<rootDir>/__tests__/groupState.test.ts',
    '<rootDir>/__tests__/inboundErrors.test.ts',
    '<rootDir>/__tests__/memberStatus.test.ts',
    '<rootDir>/__tests__/bleMesh.logic.test.ts',
    '<rootDir>/__tests__/imageMsg.test.ts',
    '<rootDir>/__tests__/richMsg.test.ts',
    '<rootDir>/__tests__/meshPresence.test.ts',
    '<rootDir>/__tests__/bleIdentity.test.ts',
    '<rootDir>/__tests__/bleFlood.test.ts',
    '<rootDir>/__tests__/bleFrag.test.ts',
    '<rootDir>/__tests__/pinSecurity.test.ts',
    '<rootDir>/__tests__/composerBudget.test.ts',
    '<rootDir>/__tests__/linkify.test.ts',
    '<rootDir>/__tests__/reactions.test.ts',
    '<rootDir>/__tests__/pins.test.ts',
    '<rootDir>/__tests__/reply.test.ts',
    '<rootDir>/__tests__/media.test.ts',
    '<rootDir>/__tests__/pfp.test.ts',
    '<rootDir>/__tests__/groupcfg.test.ts',
    '<rootDir>/__tests__/address-marker.test.ts',
    '<rootDir>/__tests__/metadataPrivacy.test.ts',
    '<rootDir>/__tests__/a11yLabels.test.ts',
    '<rootDir>/__tests__/videoA11y.test.ts',
    '<rootDir>/__tests__/videoCancel.test.ts',
  ],
};
