// #385 — sendStagedVideo must honour a CANCELLED transcode.
//
// The native transcoder resolves a cancelled job with {skipped:true, cancelled:true,
// path:<original>} — the same `path` shape as the graceful "compression failed, send it
// anyway" fallback. That overlap is the trap: if the send flow only looks at `path`, a
// cancel still uploads and sends the untouched original, i.e. exactly the video the user
// asked us to stop. These tests pin the distinction:
//   cancelled ⇒ no upload, no send, bubble cleared, no error;
//   skipped (not cancelled) ⇒ still sent, from the original path.
import type {PickedRawMedia} from '../src/native/ImagePicker';

const mockUploadEncrypted = jest.fn();
const mockTranscode = jest.fn();

jest.mock('../src/native/LogosChat', () => ({
  __esModule: true,
  default: {listConversations: jest.fn().mockResolvedValue('[]')},
  addLogosChatListener: () => ({remove() {}}),
  shortAddress: (a: string) => a,
}));
jest.mock('../src/native/MeshCore', () => ({
  __esModule: true,
  default: {},
  addMeshListener: () => ({remove() {}}),
  parseChannels: () => [],
}));
jest.mock('../src/native/Storage', () => ({
  __esModule: true,
  default: {uploadEncrypted: (...a: any[]) => mockUploadEncrypted(...a)},
}));
jest.mock('../src/native/VideoTranscoder', () => ({
  __esModule: true,
  default: {
    transcode: (...a: any[]) => mockTranscode(...a),
    cancelTranscode: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {useChatStore} = require('../src/stores/chatStore');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {useNodeStore} = require('../src/stores/nodeStore');

const VIDEO: PickedRawMedia = {
  path: '/cache/raw/original.mp4',
  mime: 'video/mp4',
  width: 1920,
  height: 1080,
  byteLength: 40_000_000,
  posterPath: '/cache/raw/poster.jpg',
};

let send: jest.Mock;

beforeEach(() => {
  mockUploadEncrypted.mockReset();
  mockTranscode.mockReset();
  send = jest.fn().mockResolvedValue(undefined);
  useChatStore.setState({mediaSends: {}, send});
  useNodeStore.setState({error: null});
});

describe('sendStagedVideo — cancelled transcode (#385)', () => {
  it('does NOT upload or send the original when the transcode was cancelled', async () => {
    mockTranscode.mockResolvedValue({
      path: VIDEO.path, // native hands back the ORIGINAL on the cancel path
      skipped: true,
      cancelled: true,
    });

    await useChatStore.getState().sendStagedVideo(7, VIDEO);

    expect(mockTranscode).toHaveBeenCalledTimes(1);
    expect(mockUploadEncrypted).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('clears the in-flight bubble and surfaces no error (a cancel is not a failure)', async () => {
    mockTranscode.mockResolvedValue({path: VIDEO.path, skipped: true, cancelled: true});

    await useChatStore.getState().sendStagedVideo(7, VIDEO);

    expect(useChatStore.getState().mediaSends).toEqual({});
    expect(useNodeStore.getState().error).toBeNull();
  });

  it('never leaves the bubble stuck in the "sending" phase after a cancel', async () => {
    const phases: string[] = [];
    mockTranscode.mockImplementation(async () => {
      const inFlight: any = Object.values(useChatStore.getState().mediaSends)[0];
      phases.push(inFlight.phase);
      return {path: VIDEO.path, skipped: true, cancelled: true};
    });

    await useChatStore.getState().sendStagedVideo(7, VIDEO);

    expect(phases).toEqual(['compressing']);
    expect(useChatStore.getState().mediaSends).toEqual({});
  });
});

describe('sendStagedVideo — uncancelled paths still send (#385)', () => {
  it('sends a normally-compressed video', async () => {
    mockTranscode.mockResolvedValue({path: '/cache/media-out/enc_1.mp4', width: 1280, height: 720});
    mockUploadEncrypted.mockResolvedValue({cid: 'CID', key: 'KEY', cap: 'CAP'});

    await useChatStore.getState().sendStagedVideo(7, VIDEO);

    expect(mockUploadEncrypted).toHaveBeenCalledWith('/cache/media-out/enc_1.mp4', expect.any(String));
    expect(send).toHaveBeenCalledTimes(1);
    const [convoPk, marker] = send.mock.calls[0];
    expect(convoPk).toBe(7);
    expect(marker).toContain('CID');
    expect(useChatStore.getState().mediaSends).toEqual({});
  });

  it('still sends the original when compression was SKIPPED but not cancelled', async () => {
    mockTranscode.mockResolvedValue({path: VIDEO.path, skipped: true});
    mockUploadEncrypted.mockResolvedValue({cid: 'CID', key: 'KEY', cap: 'CAP'});

    await useChatStore.getState().sendStagedVideo(7, VIDEO);

    expect(mockUploadEncrypted).toHaveBeenCalledWith(VIDEO.path, expect.any(String));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
