// #344 + #479 (review of PR #480): a storage-off group must make ZERO Logos
// Storage requests — on the RECEIVE side too, not just the send side.
//
// THE BUG THIS PINS. The unified media viewer (#479) added a second, wider path
// to the same blobs the bubble guard was protecting:
//
//   ChatScreen.openMediaViewer → enumerateMedia(all rows)  ← no storageOff filter
//   MediaViewer page           → useMediaBlob(parseMedia(item.content))
//
// The bubble guard (`mediaBlocked` in ChatScreen) hands `null` to useMediaBlob
// so a store*: bubble never fetches, and it stays untappable in a storage-off
// group. But #422 keeps INLINE `img1v:` photos allowed there — and tapping one
// opened the pager over EVERY historical media message in the thread, stored
// blobs included. The FlatList renders the active page and its neighbours, so
// simply opening an allowed inline photo downloaded + decrypted older Storage
// media. That bypasses the bubble guard entirely and breaks the documented
// zero-Storage-fetch policy without the user ever asking for those items.
//
// Two independent defences, tested here as two independent decisions:
//   1. enumerateMedia({storageOff}) — stored items never enter the pager.
//   2. viewerMediaRef(content, storageOff) — the ONLY ref the viewer's blob
//      hooks resolve; null under storage-off, so useMediaBlob cannot fetch even
//      if an item reached the pager some other way.
import {
  classifyMedia,
  enumerateMedia,
  isStoredMedia,
  mediaIndexOf,
  viewerMediaRef,
} from '../src/media/mediaList';
import {buildImageLocal} from '../src/native/imageMsg';
import {encodeMedia} from '../src/messages/media';
import {readFileSync} from 'fs';
import * as path from 'path';

const inlinePhoto = buildImageLocal(
  {mime: 'image/jpeg', width: 100, height: 80},
  '/x/p.jpg',
);
const storedGif = encodeMedia({
  cid: 'a'.repeat(46),
  key: 'k'.repeat(43) + '=',
  mime: 'image/gif',
  width: 200,
  height: 200,
});
const storedVideo = encodeMedia({
  cid: 'b'.repeat(46),
  key: 'k'.repeat(43) + '=',
  mime: 'video/mp4',
  width: 640,
  height: 360,
});
// #423: an HQ photo is a store*: image — a *photo* by kind, but still a fetch.
const storedHqPhoto = encodeMedia({
  cid: 'c'.repeat(46),
  key: 'k'.repeat(43) + '=',
  mime: 'image/jpeg',
  width: 300,
  height: 300,
});

// A thread that mixes both: one allowed inline photo among older stored media.
const rows = [
  {msgPk: 1, at: 100, text: storedGif, senderAccount: '0xAlice'},
  {msgPk: 2, at: 200, text: storedVideo, senderAccount: '0xBob'},
  {msgPk: 3, at: 300, text: storedHqPhoto, senderAccount: '0xAlice'},
  {msgPk: 4, at: 400, text: inlinePhoto, senderAccount: '0xBob'},
  {msgPk: 5, at: 500, text: 'just text'},
];

describe('isStoredMedia — what costs a Storage fetch', () => {
  it('is true for store*: media and false for an inline photo', () => {
    expect(isStoredMedia(storedGif)).toBe(true);
    expect(isStoredMedia(storedVideo)).toBe(true);
    expect(isStoredMedia(storedHqPhoto)).toBe(true); // an HQ photo still fetches
    expect(isStoredMedia(inlinePhoto)).toBe(false); // #422: never touches Storage
  });

  it('is false for non-media and malformed markers', () => {
    expect(isStoredMedia('hello')).toBe(false);
    expect(isStoredMedia('')).toBe(false);
    expect(isStoredMedia('store2:not-valid')).toBe(false);
  });
});

describe('enumerateMedia — storage-off keeps stored media out of the pager', () => {
  // Non-vacuity: without the flag the stored items ARE there. If this ever goes
  // green trivially (e.g. the markers stop parsing), the guard test below means
  // nothing — so assert the pre-fix behaviour explicitly.
  it('includes stored media when Storage is on', () => {
    const items = enumerateMedia(rows);
    expect(items.map(i => i.msgPk)).toEqual([1, 2, 3, 4]);
    expect(items.filter(i => isStoredMedia(i.content))).toHaveLength(3);
  });

  it('excludes every stored item when Storage is off', () => {
    const items = enumerateMedia(rows, {storageOff: true});
    expect(items.map(i => i.msgPk)).toEqual([4]); // the inline photo only
    expect(items.every(i => !isStoredMedia(i.content))).toBe(true);
  });

  it('still opens the pager at the tapped inline photo (#422 stays usable)', () => {
    const items = enumerateMedia(rows, {storageOff: true});
    expect(mediaIndexOf(items, 4)).toBe(0); // tap resolves → viewer opens
    expect(classifyMedia(items[0].content)).toBe('photo');
  });

  it('opts.storageOff false/absent behaves like Storage on', () => {
    expect(enumerateMedia(rows, {storageOff: false}).map(i => i.msgPk)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(enumerateMedia(rows, {}).map(i => i.msgPk)).toEqual([1, 2, 3, 4]);
  });

  it('leaves ordering and sender attribution intact when filtering', () => {
    const mixed = [
      {msgPk: 9, at: 100, text: inlinePhoto, senderAccount: '0xCarol'},
      {msgPk: 7, at: 100, text: storedGif, senderAccount: '0xDave'},
      {msgPk: 8, at: 50, text: inlinePhoto, senderAccount: null},
    ];
    const items = enumerateMedia(mixed, {storageOff: true});
    expect(items.map(i => i.msgPk)).toEqual([8, 9]); // oldest-first preserved
    expect(items[1].sender).toBe('0xCarol');
  });
});

describe('viewerMediaRef — the viewer hooks can never fetch under storage-off', () => {
  // This is the ref handed to useMediaBlob. null ⇒ the hook goes idle and no
  // download/decrypt is ever requested (see mediaCache.useMediaBlob).
  it('resolves a real ref for stored media when Storage is on', () => {
    const ref = viewerMediaRef(storedGif, false);
    expect(ref).not.toBeNull();
    expect(ref!.cid).toBe('a'.repeat(46));
  });

  it('is null for EVERY stored kind when Storage is off', () => {
    expect(viewerMediaRef(storedGif, true)).toBeNull();
    expect(viewerMediaRef(storedVideo, true)).toBeNull();
    expect(viewerMediaRef(storedHqPhoto, true)).toBeNull();
  });

  it('is null for an inline photo either way (it has no blob to fetch)', () => {
    expect(viewerMediaRef(inlinePhoto, false)).toBeNull();
    expect(viewerMediaRef(inlinePhoto, true)).toBeNull();
  });
});

// Both decisions above can be perfectly correct while the wiring drops the flag
// on the floor — which is exactly how the bug existed (enumerateMedia was right,
// it just was never told). The logic suite runs under a react-native stub and
// cannot mount a screen, so these are source-shape gates, in the same spirit as
// chatHeaderDeps.test.ts. They are about the SHAPE of the fetch path, not the
// spelling of one identifier: a new blob-resolving hook added to the viewer
// without routing through viewerMediaRef fails here.
describe('wiring — the storage-off flag actually reaches both defences', () => {
  const src = (rel: string) =>
    readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
  const chat = src('screens/ChatScreen.tsx');
  const viewer = src('components/MediaViewer.tsx');

  it('ChatScreen passes storageOff into enumerateMedia', () => {
    const call = /enumerateMedia\(([\s\S]*?)\n\s{4}\);/.exec(chat);
    expect(call).not.toBeNull();
    expect(call![1]).toMatch(/storageOff/);
  });

  it('ChatScreen passes storageOff into <MediaViewer>', () => {
    const el = /<MediaViewer\b([\s\S]*?)\/>/.exec(chat);
    expect(el).not.toBeNull();
    expect(el![1]).toMatch(/storageOff=\{/);
  });

  it('every useMediaBlob in the viewer resolves its ref via viewerMediaRef', () => {
    // Split on function boundaries and check each body that fetches.
    const bodies = viewer.split(/\nfunction /).filter(b => b.includes('useMediaBlob('));
    expect(bodies.length).toBeGreaterThanOrEqual(2); // usePagePath + useActivePath
    for (const body of bodies) {
      expect(body).toMatch(/viewerMediaRef\(/);
      expect(body).toMatch(/storageOff/);
    }
    // And no hook is fed a raw marker parse, the pre-fix shape.
    expect(viewer).not.toMatch(/useMediaBlob\(\s*parseMedia\(/);
  });
});
