// chatStore (zustand) — a live VIEW over the durable native store. SQLite is the
// source of truth; every write happens native-side BEFORE JS sees the event
// (persist-before-forward). This store only queries + mirrors.
//
// Identity: the STABLE convoPk (survives restarts). A conversation is keyed by the
// peer ADDRESS native-side; the UI works in convoPks.
import {create} from 'zustand';
import LogosChat, {addLogosChatListener, shortAddress} from '../native/LogosChat';
import type {ConversationRow, MessageRow, GroupMember} from '../native/LogosChat';
import MeshCore, {addMeshListener, parseChannels} from '../native/MeshCore';
import {isRelay, wrapRelay} from '../native/relay';
import {truncateToBytes, MESH_TEXT_MTU_BYTES} from '../mesh/composerBudget';
import {encodeReaction} from '../messages/reactions';
import {displayBody} from '../messages/reply';
import {isMediaContent, mediaLabel} from '../messages/media';
import {encodePin} from '../messages/pins';
import {encodePfp, encodePfpClear, isPfpClear, isPfpContent, parsePfp} from '../messages/pfp';
import {encodeGroupCfg, isGroupCfgContent, parseGroupCfg} from '../messages/groupcfg';
import {isAddrContent, parseAddr} from '../messages/address';
import {encodeLeave} from '../messages/leave';
import {isImageContent, parseImageLocal} from '../native/imageMsg';
import {parseVoiceLocal, isVoiceContent} from '../native/voiceMsg';
import {isLocationContent} from '../native/locMsg';
import Storage from '../native/Storage';
import {encodeMedia} from '../messages/media';
import ImagePicker, {
  parsePicked,
  parseRawMedia,
  parsePickedArray,
  type PickedImage,
  type PickedRawMedia,
} from '../native/ImagePicker';
import VideoTranscoder from '../native/VideoTranscoder';
import LocationNative, {parseLocation as parseNativeLocation} from '../native/Location';
import {buildLocation, type LatLng} from '../native/locMsg';
import AudioRecorder, {parseRecording} from '../native/Audio';
import {DeviceEventEmitter, PermissionsAndroid, Platform} from 'react-native';

/** #308: a video send in flight — compressing then uploading, with a 0..1 ring. */
export interface MediaSend {
  id: string;
  convoPk: number;
  /** first-frame poster (absolute path) shown under the ring. */
  poster: string | null;
  phase: 'compressing' | 'sending';
  progress: number;
  startedAt: number;
}
import {useNodeStore} from './nodeStore';
import {useMeshStore} from './meshStore';
import {useAvatarStore} from './avatarStore';
import {convoDisplayName} from './conversationView';

export type {ConversationRow as Conversation, MessageRow as Message};
export type {GroupMember} from '../native/LogosChat';

/**
 * #168 (Phase 2c): sentinel prefixing a group's mesh-mirror invite DM
 * (`<prefix><idx>:<32hexkey>:<name>`). A peer running this app recognises it and
 * auto-joins the mirror channel; an official-app peer just sees the text.
 */
export const MESH_INVITE_PREFIX = 'lmi:';

/** A UI-only note rendered inline in a thread (never stored, never sent). */
export interface SystemNote {
  id: string;
  text: string;
  /** #188: creation time, so system lines interleave into the timeline by time
   *  instead of being pinned below every message. */
  at: number;
  /** #192: optional explainer key — when set, the line shows an (i) that opens
   *  the matching info modal ('invited-wait'), or (#195) an action affordance
   *  ('join-failed' → a "Re-invite" tap). */
  info?: string;
  /** #195: the address this note's action targets (e.g. the invitee to
   *  re-invite for a 'join-failed' line). Threaded so the UI can act without a
   *  side lookup. */
  infoAddress?: string;
  /** #230: for a membership-status line (invited/hasn't-joined/joined/left), the
   *  normalized member address it describes. There is at most ONE such line per
   *  member per thread — `setMemberStatus` upserts by this key, so a member's line
   *  advances in place (invited → hasn't joined → joined) instead of the statuses
   *  stacking up. Undefined for ordinary notes (group re-created, mesh, …). */
  member?: string;
}

/** #160: what the conversation list row shows as its preview + timestamp. */
export interface ConvoPreview {
  text: string;
  at: number;
  /** True when the preview is a system note (render it subtly), not a message. */
  isSystem: boolean;
}

/**
 * #160: the list preview for a conversation = whichever is NEWER, the last
 * durable message (`lastText`/`lastMessageAt`) or the latest in-memory system
 * note for the thread. System notes (invited/joined/left, group ended, mesh
 * bridging) are UI-only and never persisted, so a thread whose newest event is a
 * system line would otherwise show a stale message; this surfaces it instead.
 * Pure/derived — reads both sources, mutates nothing. `systemLines` are appended
 * in time order (pushSystemLine stamps `Date.now()`), so the last one is latest.
 */
/** #207: max photos per album send (matches common apps + our 1-msg-per-image model). */
export const MAX_ALBUM = 10;

/** Request a single Android runtime permission; true if granted (or non-Android). */
async function ensurePerm(perm: any): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    const res = await PermissionsAndroid.request(perm);
    return res === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

export function conversationPreview(
  convo: ConversationRow,
  systemLines: SystemNote[] | undefined,
): ConvoPreview {
  const latest =
    systemLines != null && systemLines.length > 0
      ? systemLines[systemLines.length - 1]
      : null;
  if (latest != null && latest.at > convo.lastMessageAt) {
    return {text: latest.text, at: latest.at, isSystem: true};
  }
  // Media last-messages are markers, not readable text — preview with a label.
  // #295: a reply's last-text is a reply1: marker → preview its body.
  const lt = displayBody(convo.lastText);
  const text = isMediaContent(lt)
    ? mediaLabel(lt) // #300: GIF / Video / Media
    : isImageContent(lt)
    ? '📷 Photo'
    : isVoiceContent(lt)
    ? '🎤 Voice message'
    : isLocationContent(lt)
    ? '📍 Location'
    : isAddrContent(lt)
    ? // #330: a shared contact card — name it when a label travelled.
      (() => {
        const a = parseAddr(lt);
        return a?.label != null ? `Contact: ${a.label}` : 'Shared a contact';
      })()
    : lt;
  return {text, at: convo.lastMessageAt, isSystem: false};
}

interface ChatState {
  conversations: Record<number, ConversationRow>;
  messages: Record<number, MessageRow[]>;
  members: Record<number, GroupMember[]>;
  /** #210: address(lowercase) → mesh mapping, cached from the DB on refresh so any
   * contact (even a pure 1:1) reflects its mesh identity. */
  meshMap: Record<string, {pubkey: string; name: string | null}>;
  activeConvoPk: number | null;
  refreshConversations: () => Promise<void>;
  loadMessages: (convoPk: number) => Promise<void>;
  /**
   * #37: fetch the next OLDER page and PREPEND it to `messages[convoPk]`
   * (de-duped by msgPk). No-op once `reachedEnd[convoPk]` is set (a short page
   * came back) or while a load is already in flight for that convo.
   */
  loadMoreMessages: (convoPk: number) => Promise<void>;
  /** #37: per-convo — the oldest page has been reached (a short page returned). */
  reachedEnd: Record<number, boolean>;
  /** #37: per-convo — an older-page load is in flight (guards duplicate loads). */
  loadingMore: Record<number, boolean>;
  /** Create (or reuse) a 1:1 conversation with a peer address. Resolves convoPk. */
  startConversation: (
    peerAddress: string,
    opts?: {nickname?: string; verified?: boolean},
  ) => Promise<number>;
  /** Create an MLS group (name + optional description). Resolves convoPk. */
  createGroup: (name: string, description?: string) => Promise<number>;
  /** Add a peer (by hex address) to a group. */
  addMember: (convoPk: number, address: string) => Promise<void>;
  /** Load a group's roster (app-side, best-effort). */
  loadMembers: (convoPk: number) => Promise<void>;
  /** #168 (Phase 2): map/unmap a Logos address ↔ a MeshCore identity, then reload the group roster. */
  mapMeshIdentity: (convoPk: number, address: string, meshPubkey: string, meshName: string | null) => Promise<void>;
  unmapMeshIdentity: (convoPk: number, address: string) => Promise<void>;
  /** #210: map/unmap a contact by address alone (no group context — e.g. from the
   * Contacts screen or a 1:1). Refreshes the meshMap cache + rosters. */
  setContactMeshMap: (address: string, meshPubkey: string, meshName: string | null) => Promise<void>;
  clearContactMeshMap: (address: string) => Promise<void>;
  /**
   * #168 (Phase 2c): switch a Logos group onto a MeshCore mirror channel — create a
   * private channel, DM its key to each mapped member, route sends there. Resolves
   * with the chosen slot + how many mapped members were invited.
   */
  switchGroupToMesh: (convoPk: number) => Promise<{channelIdx: number; invited: number}>;
  /** #168 (Phase 2c): switch a mirrored group back to the Logos node. */
  switchGroupToLogos: (convoPk: number) => Promise<void>;
  /** Send a message into a conversation (1:1 or group). */
  send: (convoPk: number, text: string) => Promise<void>;
  /** #264: react to a message by its cross-device key (op '+' add / '-' remove).
   *  Sends a `react1:` marker over the conversation's transport(s) like any message;
   *  folded into per-message aggregates on load (never shown as a bubble). */
  sendReaction: (
    convoPk: number,
    targetKey: string,
    emoji: string,
    op: '+' | '-',
  ) => Promise<void>;
  /** #266: pin ('+') or unpin ('-') a message by its cross-device key. Sends a
   *  `pin1:` marker (folded into the pin bar on load; never shown as a bubble). */
  pinMessage: (convoPk: number, targetKey: string, op: '+' | '-') => Promise<void>;
  /**
   * #197: pick an image from the gallery and send it over Logos (1:1 or group).
   * Images are Logos-only — never mirrored to the mesh (LoRa can't carry them).
   * No-op if the user cancels the picker.
   */
  sendImage: (convoPk: number) => Promise<void>;
  /**
   * #306: pick a GIF (image/gif only), encrypt + upload it to Logos Storage, and send a
   * `store1:` marker (cid + key) — the blob rides Storage, not the wire. Logos-only.
   */
  sendGif: (convoPk: number) => Promise<void>;
  /**
   * #314: pick a photo, downscale it hard (256px), encrypt + upload it to Logos Storage,
   * store it as the local user's own avatar, and broadcast a `pfp1:` marker to every Logos
   * conversation so peers replace the identicon with it. Resolves when the broadcast is done.
   */
  setAvatar: () => Promise<void>;
  clearAvatar: () => Promise<void>;
  /** #307: pick a video (video/* only) to STAGE in the composer (guards + pick, no send). */
  stageVideo: (convoPk: number) => Promise<PickedRawMedia | null>;
  /**
   * #305/#308: compress the staged video on-device (compressing ring), encrypt + upload it
   * (sending ring), then send the `store1:` marker. Progress surfaces via {@link mediaSends}.
   */
  sendStagedVideo: (convoPk: number, video: PickedRawMedia) => Promise<void>;
  /** #308: in-flight media sends (video compress→upload), keyed by a temp id. */
  mediaSends: Record<string, MediaSend>;
  /** #261: pick up to {@link MAX_ALBUM} images to STAGE (guards + pick, no send). */
  stageImages: (convoPk: number) => Promise<PickedImage[]>;
  /** #261: capture a photo to STAGE (guards + camera permission, no send). */
  stageCameraPhoto: (convoPk: number) => Promise<PickedImage[]>;
  /** #261: send previously-staged images (each its own message, in order). */
  sendStagedImages: (convoPk: number, images: PickedImage[]) => Promise<void>;
  /** #204: share the current location as clickable coordinates. */
  sendLocation: (convoPk: number) => Promise<void>;
  /**
   * #255: acquire the current location (permission + fix) WITHOUT sending, so the
   * composer can preview it and let the user confirm. Returns null on
   * denial/failure (error is surfaced via nodeStore).
   */
  fetchLocation: () => Promise<LatLng | null>;
  /** #255: send a location the user already previewed/confirmed. */
  sendLocationValue: (convoPk: number, loc: LatLng) => Promise<void>;
  /** #205: send an already-recorded voice note. */
  sendVoice: (
    convoPk: number,
    rec: {mime: string; durationMs: number; waveform: number[]; base64: string},
  ) => Promise<void>;
  /** #201: forward any message content (text/image/voice/location, incl. own) to another convo. */
  forwardMessage: (content: string, toConvoPk: number) => Promise<void>;
  /** Re-send a failed outbound message. */
  retry: (convoPk: number, msgPk: number) => Promise<void>;
  setActive: (convoPk: number | null) => void;
  markRead: (convoPk: number) => void;
  /** Set (or change) a conversation's nickname. */
  setNickname: (convoPk: number, name: string) => Promise<void>;
  /** #153: set the local verified flag for a contact/conversation. */
  setVerified: (convoPk: number, verified: boolean) => Promise<void>;
  /** Wipe a group's local content but keep receiving new messages (#107). */
  wipe: (convoPk: number) => Promise<void>;
  /** Ask the group to remove us, then drop it locally (#108). */
  leaveGroup: (convoPk: number) => Promise<void>;
  /** Per-thread system notes (invited/joined, group revived) — UI-only, not persisted. */
  systemLines: Record<number, SystemNote[]>;
  /** Append a system note to a thread. `info` tags it with an explainer key (#192);
   *  `infoAddress` threads the address an action line targets (#195). */
  pushSystemLine: (
    convoPk: number,
    text: string,
    info?: string,
    infoAddress?: string,
  ) => void;
  /** #230: upsert a member's membership-status line (invited/not-joined/joined/left)
   *  IN PLACE — replaces any prior status line for that member so the timeline shows
   *  exactly one, current line per member instead of a growing stack. */
  setMemberStatus: (
    convoPk: number,
    address: string,
    status: 'invited' | 'not-joined' | 'joined' | 'left',
    /** #252: override the note's timestamp. A join learned via a (late) join-ack
     *  should sort at the group's start, not when the ack landed — else the line
     *  interleaves AFTER messages the member already sent. Defaults to now. */
    at?: number,
  ) => void;
  /** #230: drop all per-member status lines for a thread (e.g. on group re-create,
   *  so the fresh invite round starts clean). Non-membership notes are kept. */
  clearMemberStatuses: (convoPk: number) => void;
  /** #228: load persisted system notes for a thread into memory (on thread open). */
  hydrateSystemLines: (convoPk: number) => Promise<void>;
  /** #344: per-group storage opt-out — true ⇒ this group is text-only (no media
   *  sent/fetched), folded from the newest gcfg1: marker + persisted to KV. */
  storageOff: Record<number, boolean>;
  /** #344: creator-only — flip a group's storage on/off. Broadcasts a gcfg1: marker,
   *  updates `storageOff[convoPk]`, and persists to KV. No-op for non-creators. */
  setGroupStorage: (convoPk: number, off: boolean) => Promise<void>;
  /** #344: load the persisted storage-off flag for a group into memory (on open). */
  hydrateGroupStorage: (convoPk: number) => Promise<void>;
  /** #112: 'live' | 'dead' | 'unknown' per group, filled lazily by probeGroup. */
  liveness: Record<number, string>;
  /** #112: probe whether the lib can still operate this group. */
  probeGroup: (convoPk: number) => Promise<string>;
  /** #112: re-create a dead group in place. Resolves {invited,total}. */
  recreateGroup: (convoPk: number) => Promise<{invited: number; total: number}>;
  /**
   * #112: revive a dead group and send `text` ONCE THE INVITEE HAS JOINED.
   * MLS gives a joiner no history, so a message published between the re-create
   * and their join is undeliverable to them — it is not slow, it is structurally
   * lost. The creator receives `members_changed` when the add commits (observed
   * ~60s), so we hold the message until then (with a timeout fallback).
   */
  reviveAndSend: (convoPk: number, text: string) => Promise<{invited: number; total: number}>;
  /** Delete a conversation + its messages and drop it from the list. */
  remove: (convoPk: number) => Promise<void>;
  /** #263: delete a single message from local history (this device only). */
  deleteMessage: (convoPk: number, msgPk: number) => Promise<void>;
  /** #167: get-or-create a MeshCore channel conversation (by idx). Resolves convoPk. */
  openMeshChannel: (idx: number, name: string) => Promise<number>;
  /** #167 (Phase 1b): get-or-create a MeshCore ECDH DM conversation (by pubkey). Resolves convoPk. */
  startMeshDm: (pubkeyHex: string, name: string | null) => Promise<number>;
  /**
   * #328: drop ALL in-memory state. Called on identity reset/wipe — the native
   * side deletes the identity + DB, but the JS store survives, and `convoPk` is an
   * autoincrement that restarts at 1 after the DB is deleted. Without this, a new
   * conversation reusing an old `convoPk` renders the previous identity's cached
   * messages/system-lines (bug #328: phantom "joined" lines in a fresh DM).
   */
  reset: () => void;
}

// Pure view helpers live in conversationView.ts (RN-free, unit-tested);
// re-exported here so existing screen imports keep resolving from chatStore.
export {
  sortedConversations,
  convoDisplayName,
  conversationA11yLabel,
  knownContacts,
  filterContacts,
  isAddressVerified,
  oldestMsgPk,
  mergeOlderPage,
} from './conversationView';
import {
  oldestMsgPk,
  mergeOlderPage,
  memberStatusFields,
  upsertMemberNote,
  clearMemberNotes,
} from './conversationView';
export type {KnownContact} from './conversationView';

const PAGE = 200;

/** "Alice 0c87f0…71c6", or just the short hex when we have no label for them. */
export function describePeer(address: string): string {
  const target = address.toLowerCase();
  for (const c of Object.values(useChatStore.getState().conversations)) {
    if (
      !c.isGroup &&
      c.peerAddress?.toLowerCase() === target &&
      c.nickname != null &&
      c.nickname.length > 0
    ) {
      return `${c.nickname} ${shortAddress(address)}`;
    }
  }
  return shortAddress(address);
}

/**
 * Addresses invited but not yet committed, per conversation. `members_changed`
 * says a roster changed but not WHO, and de-mls commits one round at a time, so
 * we release these FIFO — the order we invited them in.
 */
const pendingJoins: Record<number, string[]> = {};

/** #252: groups this session has already sent a join-ack for, so `group_ready`
 *  firing again (e.g. a reload) doesn't re-ack. Cleared entry retried on failure. */
const ackedGroups = new Set<number>();

/** #252: per-group state for re-announcing our own presence when a NEW member
 *  appears — so a fresh joiner learns every EXISTING member (esp. the CREATOR,
 *  which never sends an initial group_ready ack). `seen` prevents ping-pong;
 *  `at` throttles the re-broadcast so simultaneous joins don't storm. */
const rebroadcast: Record<number, {seen: Set<string>; at: number}> = {};

// #228: system notes (invited/joined/left/group-ended) persist per conversation in
// the KV store so they survive an app restart. Bounded so KV never grows unbounded.
const SYSLINE_CAP = 60;
const sysLineKey = (convoPk: number) => `sysln:${convoPk}`;
function persistSystemLines(convoPk: number, notes: SystemNote[]): void {
  LogosChat.setSetting(sysLineKey(convoPk), JSON.stringify(notes)).catch(() => {});
}

// #344: per-group storage-off flag persists in the KV store so the text-only mode
// survives an app restart (like the folded pfp/systemline state).
const gcfgKey = (convoPk: number) => `gcfg:${convoPk}`;
function persistGroupStorage(convoPk: number, off: boolean): void {
  LogosChat.setSetting(gcfgKey(convoPk), off ? 'off' : 'on').catch(() => {});
}

/**
 * #195: how long we wait for an invitee's `members_changed` "joined" before we
 * stop pretending it's on its way. An invitee whose node has no subscribed peers
 * never receives the MLS welcome (there is no store replay), so it silently never
 * joins — after this window we surface an honest "hasn't joined" line offering a
 * re-invite, rather than leaving "invited" sitting there forever.
 */
const JOIN_TIMEOUT_MS = 90_000;

/**
 * #195: per-conversation timers, one per outstanding invite, FIFO like
 * `pendingJoins`. A `members_changed` join clears the matching timer; if a timer
 * fires first, the invite is treated as failed.
 */
interface PendingInvite {
  address: string;
  timer: ReturnType<typeof setTimeout>;
}
const pendingInvites: Record<number, PendingInvite[]> = {};

/** #195: drop + clear the first outstanding invite timer for `address`, if any. */
function clearPendingInvite(convoPk: number, address: string) {
  const q = pendingInvites[convoPk];
  if (q == null) return;
  const i = q.findIndex(p => p.address === address);
  if (i >= 0) {
    clearTimeout(q[i].timer);
    q.splice(i, 1);
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: {},
  meshMap: {},
  messages: {},
  members: {},
  systemLines: {},
  storageOff: {},
  liveness: {},
  reachedEnd: {},
  loadingMore: {},
  activeConvoPk: null,

  reset: () => {
    // Module-level mutable caches (not in `set` state) — clear in place, and cancel
    // any outstanding invite timers so they don't fire against the new identity.
    for (const k of Object.keys(pendingJoins)) delete (pendingJoins as Record<string, unknown>)[k];
    for (const q of Object.values(pendingInvites)) for (const p of q) clearTimeout(p.timer);
    for (const k of Object.keys(pendingInvites)) delete (pendingInvites as Record<string, unknown>)[k];
    for (const k of Object.keys(rebroadcast)) delete (rebroadcast as Record<string, unknown>)[k];
    ackedGroups.clear();
    // Zustand state maps — reset to empty so a reused convoPk starts clean.
    set({
      conversations: {},
      meshMap: {},
      messages: {},
      members: {},
      systemLines: {},
      storageOff: {},
      liveness: {},
      reachedEnd: {},
      loadingMore: {},
      activeConvoPk: null,
    });
  },

  refreshConversations: async () => {
    const rows: ConversationRow[] = JSON.parse(
      await LogosChat.listConversations(),
    );
    const conversations: Record<number, ConversationRow> = {};
    for (const r of rows) {
      conversations[r.convoPk] = r;
    }
    // #210: cache the full address→mesh mapping so any contact reflects its map
    // (not only those seen in a group roster).
    const meshMap: Record<string, {pubkey: string; name: string | null}> = {};
    try {
      const arr = JSON.parse(await LogosChat.listMeshMap());
      if (Array.isArray(arr)) {
        for (const m of arr) {
          if (typeof m?.address === 'string' && typeof m?.meshPubkey === 'string') {
            meshMap[m.address.toLowerCase()] = {
              pubkey: m.meshPubkey,
              name: typeof m.meshName === 'string' ? m.meshName : null,
            };
          }
        }
      }
    } catch {
      // keep the previous map on a transient read failure
    }
    set({conversations, meshMap});
  },

  loadMessages: async (convoPk: number) => {
    const rows: MessageRow[] = JSON.parse(
      await LogosChat.listMessages(convoPk, 0, PAGE),
    );
    // #37: this is the newest-page (re)load — it replaces the window, so reset
    // the paging cursor state. A short first page means there's nothing older.
    set(s => ({
      messages: {...s.messages, [convoPk]: rows},
      reachedEnd: {...s.reachedEnd, [convoPk]: rows.length < PAGE},
    }));
  },

  loadMoreMessages: async (convoPk: number) => {
    const s = get();
    if (s.loadingMore[convoPk] === true || s.reachedEnd[convoPk] === true) {
      return;
    }
    const existing = s.messages[convoPk] ?? [];
    const before = oldestMsgPk(existing);
    if (before <= 0) {
      // Nothing durable loaded yet — no cursor to page before.
      return;
    }
    set(st => ({loadingMore: {...st.loadingMore, [convoPk]: true}}));
    try {
      const older: MessageRow[] = JSON.parse(
        await LogosChat.listMessages(convoPk, before, PAGE),
      );
      set(st => ({
        messages: {
          ...st.messages,
          [convoPk]: mergeOlderPage(st.messages[convoPk] ?? existing, older),
        },
        // A short page is the end of history for this thread.
        reachedEnd: {...st.reachedEnd, [convoPk]: older.length < PAGE},
      }));
    } finally {
      set(st => ({loadingMore: {...st.loadingMore, [convoPk]: false}}));
    }
  },

  startConversation: async (peerAddress, opts) => {
    const convoPk = await LogosChat.createConversation(
      peerAddress,
      opts?.nickname ?? null,
    );
    // #153: verification is an explicit, separate flag (never defaulted).
    if (opts?.verified === true) {
      await LogosChat.setVerified(convoPk, true).catch(() => {});
    }
    await get().refreshConversations();
    await get().loadMessages(convoPk);
    return convoPk;
  },

  createGroup: async (name, description) => {
    const convoPk = await LogosChat.createGroup(name, description ?? null);
    await get().refreshConversations();
    await get().loadMessages(convoPk);
    await get().loadMembers(convoPk);
    return convoPk;
  },

  addMember: async (convoPk, address) => {
    try {
      await LogosChat.addGroupMember(convoPk, address);
    } catch (e: any) {
      // #103/#168: a GroupV2 from an earlier node session can't rehydrate its
      // MLS state ("cannot be rebuilt from storage" / "was not found" / "no load
      // path"). A mesh-MIRRORED group hits this too — its Logos side still needs
      // a live MLS group to reach Logos-only members. The creator can re-create
      // it in place (same convo_pk + history + mesh mirror; existing roster
      // re-invited), and then the add lands on the fresh group. Retry the add
      // natively (not via get().addMember) so this never recurses.
      const raw = String(e?.message ?? e);
      const rehydrateDead = /cannot be rebuilt|was not found|no load path/i.test(raw);
      const mine = get().conversations[convoPk]?.createdByMe ?? false;
      if (!rehydrateDead || !mine) {
        throw e;
      }
      await get().recreateGroup(convoPk);
      await LogosChat.addGroupMember(convoPk, address);
    }
    // Report per-member progress in the thread: invited now, joined when their
    // add actually commits (members_changed) — the two are ~a minute apart. The
    // 'invited-wait' tag adds an (i) explaining you must wait for the join before
    // sending, or those messages never reach the new member (#192).
    get().setMemberStatus(convoPk, address, 'invited');
    const lower = address.toLowerCase();
    (pendingJoins[convoPk] ??= []).push(lower);
    // #195: an invitee whose node has no subscribed peers never gets the MLS
    // welcome (no store replay) and silently never joins. Arm a timeout: if no
    // "joined" arrives, escalate the line to an honest "hasn't joined" that
    // offers a re-invite. Cleared by notifyJoin when the join actually commits.
    const timer = setTimeout(() => {
      // This invite timed out — remove it from both FIFO queues so a later,
      // unrelated join doesn't get mis-attributed to it.
      const q = pendingInvites[convoPk];
      if (q != null) {
        const i = q.findIndex(p => p.timer === timer);
        if (i >= 0) q.splice(i, 1);
      }
      const jq = pendingJoins[convoPk];
      if (jq != null) {
        const j = jq.indexOf(lower);
        if (j >= 0) jq.splice(j, 1);
      }
      get().setMemberStatus(convoPk, address, 'not-joined');
    }, JOIN_TIMEOUT_MS);
    (pendingInvites[convoPk] ??= []).push({address: lower, timer});
    await get().loadMembers(convoPk);
    await get().refreshConversations();
  },

  loadMembers: async (convoPk: number) => {
    const rows: GroupMember[] = JSON.parse(
      await LogosChat.listGroupMembers(convoPk),
    );
    set(s => ({members: {...s.members, [convoPk]: rows}}));
  },

  mapMeshIdentity: async (convoPk, address, meshPubkey, meshName) => {
    await LogosChat.setMeshMap(address, meshPubkey, meshName);
    await get().loadMembers(convoPk);
  },

  unmapMeshIdentity: async (convoPk, address) => {
    await LogosChat.clearMeshMap(address);
    await get().loadMembers(convoPk);
  },

  setContactMeshMap: async (address, meshPubkey, meshName) => {
    await LogosChat.setMeshMap(address, meshPubkey, meshName);
    await get().refreshConversations(); // reloads the meshMap cache
  },

  clearContactMeshMap: async address => {
    await LogosChat.clearMeshMap(address);
    await get().refreshConversations();
  },

  switchGroupToMesh: async (convoPk: number) => {
    const convo = get().conversations[convoPk];
    if (convo == null || !convo.isGroup) {
      throw new Error('not a group');
    }
    // Only members the user has mapped to a mesh identity can receive the mirror.
    await get().loadMembers(convoPk);
    const mapped = (get().members[convoPk] ?? []).filter(
      m => !m.isSelf && m.meshPubkey != null,
    );
    if (mapped.length === 0) {
      throw new Error('no members are mapped to a mesh identity');
    }
    // Pick the lowest free private slot (1..7; 0 is the reserved public channel).
    const used = new Set(parseChannels(await MeshCore.getChannels()).map(c => c.idx));
    let idx = -1;
    for (let i = 1; i <= 7; i++) {
      if (!used.has(i)) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      throw new Error('no free mesh channel slot on the radio');
    }
    const key = await MeshCore.randomChannelKey();
    const name = convoDisplayName(convo).slice(0, 31);
    await MeshCore.setChannel(idx, name, key);
    await LogosChat.setMeshMirror(convoPk, idx, key);
    // Invite each mapped member: an ECDH DM carrying the channel slot + key +
    // the GROUP's lib id + name. The lib id lets an invitee that already holds
    // this Logos group BIND the channel to it (setMeshMirror), so inbound mesh
    // lands in the group timeline instead of a standalone channel (#168 Bug 1).
    // A peer running this app auto-joins + binds; an official-app peer just sees
    // text. Name is last so it may contain ':'.
    const libId = (convo.libConvoId ?? '').toLowerCase();
    const invite = `${MESH_INVITE_PREFIX}${idx}:${key}:${libId}:${name}`;
    let invited = 0;
    for (const m of mapped) {
      try {
        await MeshCore.sendDm(m.meshPubkey!, invite);
        invited++;
      } catch {
        // best-effort: an unreachable member shouldn't abort the switch
      }
    }
    await get().refreshConversations();
    // #189: local marker — turning mirroring on/off is a per-device action, not
    // a group event, so it's a local system line (never broadcast).
    get().pushSystemLine(
      convoPk,
      `Now bridging over MeshCore (channel ${idx}) — ${invited} mesh member${
        invited === 1 ? '' : 's'
      } invited`,
    );
    return {channelIdx: idx, invited};
  },

  switchGroupToLogos: async (convoPk: number) => {
    await LogosChat.clearMeshMirror(convoPk);
    await get().refreshConversations();
    get().pushSystemLine(convoPk, 'Stopped MeshCore bridging — Logos only');
  },

  sendImage: async (convoPk: number) => {
    const convo = get().conversations[convoPk];
    const transport = convo?.transport ?? 'logos';
    // Pure-mesh conversations (a LoRa channel/DM) can't carry an image.
    if (transport === 'mesh') {
      useNodeStore.setState({error: 'images are not supported on mesh'});
      return;
    }
    if (useNodeStore.getState().status !== 'running') {
      useNodeStore.setState({error: 'Node is off or connecting. Make sure the node is online to send an image'});
      return;
    }
    // Pick + downscale natively to ~120 KB so it fits one Logos message.
    let picked;
    try {
      picked = parsePicked(await ImagePicker.pickImage(1024, 60_000));
    } catch (e: any) {
      useNodeStore.setState({error: String(e?.message ?? e)});
      return;
    }
    if (picked == null) return; // cancelled
    try {
      const res = JSON.parse(
        await LogosChat.sendImageTo(
          convoPk,
          picked.mime,
          picked.width,
          picked.height,
          picked.base64,
        ),
      );
      if (res.status === 'failed') {
        useNodeStore.setState({error: 'image send failed — tap to retry'});
      }
    } catch (e: any) {
      useNodeStore.setState({error: String(e?.message ?? e)});
    }
    // The own bubble + status land native-side; refresh from the DB.
    await get().loadMessages(convoPk);
    get().refreshConversations();
  },

  // #300: pick a raw gif/video → encrypt + upload to Logos Storage → send a store1:
  // marker (tiny; the blob rides Storage, key travels E2E in the marker).
  mediaSends: {},

  // #306: the GIF button — image/gif only. Small enough to upload straight away.
  sendGif: async (convoPk: number) => {
    const convo = get().conversations[convoPk];
    if ((convo?.transport ?? 'logos') === 'mesh') {
      useNodeStore.setState({error: 'gifs are not supported on mesh'});
      return;
    }
    if (useNodeStore.getState().status !== 'running') {
      useNodeStore.setState({error: 'Node is off or connecting. Make sure the node is online to send a gif'});
      return;
    }
    let raw;
    try {
      raw = parseRawMedia(await ImagePicker.pickRawMedia(8_000_000, 'gif'));
    } catch (e: any) {
      useNodeStore.setState({error: String(e?.message ?? e)});
      return;
    }
    if (raw == null) return; // cancelled
    try {
      useNodeStore.setState({error: 'uploading…'});
      const {cid, key, cap} = await Storage.uploadEncrypted(raw.path, '');
      useNodeStore.setState({error: null});
      const marker = encodeMedia({
        cid,
        key,
        cap,
        mime: raw.mime,
        width: raw.width,
        height: raw.height,
      });
      await get().send(convoPk, marker);
    } catch (e: any) {
      useNodeStore.setState({error: `gif upload failed: ${e?.message ?? e}`});
    }
  },

  // #314: set my custom avatar — pick a photo, downscale HARD (256px, ~50KB budget) so the
  // blob is tiny, encrypt + upload it to Logos Storage, cache it as `mine`, then broadcast a
  // pfp1: marker to every Logos conversation so peers render it in place of the identicon.
  setAvatar: async () => {
    if (useNodeStore.getState().status !== 'running') {
      useNodeStore.setState({error: 'Node is off or connecting. Make sure the node is online to set an avatar'});
      return;
    }
    let picked;
    try {
      picked = parsePicked(await ImagePicker.pickImage(256, 50_000));
    } catch (e: any) {
      useNodeStore.setState({error: String(e?.message ?? e)});
      return;
    }
    if (picked == null) return; // cancelled
    try {
      useNodeStore.setState({error: 'uploading avatar…'});
      // uploadEncrypted takes a file path — persist the picked JPEG to app storage first.
      const path = await ImagePicker.saveBase64Jpeg(picked.base64);
      const {cid, key, cap} = await Storage.uploadEncrypted(path, '');
      useNodeStore.setState({error: null});
      const ref = {
        cid,
        key,
        cap,
        mime: 'image/jpeg',
        width: picked.width,
        height: picked.height,
        // uploadEncrypted ALWAYS size-pads (store2, StorageModule.kt:93). The marker
        // encodes store2 either way, but `mine` is held as this raw ref (never re-parsed
        // from a marker), so it must carry padded:true or my OWN avatar downloads without
        // stripping the pad header → corrupt image. Peers parse the store2 marker → fine.
        padded: true,
      };
      useAvatarStore.getState().setMine(ref);
      // Broadcast to every current Logos conversation (media rides Storage, which mesh/ble
      // peers can't fetch — so only Logos convos). Best-effort per convo; keep it simple.
      const marker = encodePfp(ref);
      const convos = Object.values(get().conversations).filter(
        c => (c.transport ?? 'logos') === 'logos',
      );
      for (const c of convos) {
        try {
          await get().send(c.convoPk, marker);
        } catch {
          // a single failed convo must not abort the rest of the broadcast
        }
      }
    } catch (e: any) {
      useNodeStore.setState({error: `avatar upload failed: ${e?.message ?? e}`});
    }
  },

  // #314: remove my avatar — wipe it locally AND broadcast a pfp1:clear to every Logos
  // conversation so peers drop the cached photo and fall back to my identicon (not just a
  // local wipe). Best-effort per convo, like setAvatar's broadcast.
  clearAvatar: async () => {
    useAvatarStore.getState().setMine(null);
    const marker = encodePfpClear();
    const convos = Object.values(get().conversations).filter(
      c => (c.transport ?? 'logos') === 'logos',
    );
    for (const c of convos) {
      try {
        await get().send(c.convoPk, marker);
      } catch {
        // a single failed convo must not abort the rest of the broadcast
      }
    }
  },

  // #307: the Video button — video/* only, STAGED (not sent) so the composer can preview
  // a poster thumbnail and send on the user's confirm.
  stageVideo: async (convoPk: number) => {
    const convo = get().conversations[convoPk];
    if ((convo?.transport ?? 'logos') === 'mesh') {
      useNodeStore.setState({error: 'video is not supported on mesh'});
      return null;
    }
    if (useNodeStore.getState().status !== 'running') {
      useNodeStore.setState({error: 'Node is off or connecting. Make sure the node is online to send a video'});
      return null;
    }
    try {
      return parseRawMedia(await ImagePicker.pickRawMedia(0, 'video'));
    } catch (e: any) {
      useNodeStore.setState({error: String(e?.message ?? e)});
      return null;
    }
  },

  // #305/#308: compress the staged video on-device (compressing ring), then encrypt+upload
  // (sending ring), then send the store1: marker. A `mediaSends` entry drives the in-chat ring.
  sendStagedVideo: async (convoPk: number, video: PickedRawMedia) => {
    const id = `v${Date.now()}`;
    set(s => ({
      mediaSends: {
        ...s.mediaSends,
        [id]: {
          id,
          convoPk,
          poster: video.posterPath ?? null,
          phase: 'compressing' as const,
          progress: 0,
          startedAt: Date.now(),
        },
      },
    }));
    const clear = () =>
      set(s => {
        const {[id]: _drop, ...rest} = s.mediaSends;
        return {mediaSends: rest};
      });
    try {
      // 1) compress (native emits mediaProgress phase=compressing keyed by id)
      const enc = await VideoTranscoder.transcode(video.path, id);
      // #385: a CANCELLED transcode resolves with `path` = the ORIGINAL, uncompressed clip
      // (same shape as the graceful `skipped` fallback). `skipped` means "compression failed,
      // send it anyway"; `cancelled` means "the user asked us to stop" — so we must drop the
      // send here. Falling through would upload and send the very video the cancel targeted.
      if (enc.cancelled) {
        clear();
        return;
      }
      // 2) upload (native emits mediaProgress phase=sending keyed by id)
      set(s =>
        s.mediaSends[id] == null
          ? {}
          : {mediaSends: {...s.mediaSends, [id]: {...s.mediaSends[id], phase: 'sending', progress: 0}}},
      );
      const {cid, key, cap} = await Storage.uploadEncrypted(enc.path, id);
      const marker = encodeMedia({
        cid,
        key,
        cap,
        mime: 'video/mp4',
        width: enc.width && enc.width > 0 ? enc.width : video.width,
        height: enc.height && enc.height > 0 ? enc.height : video.height,
      });
      clear();
      await get().send(convoPk, marker);
    } catch (e: any) {
      clear();
      useNodeStore.setState({error: `video send failed: ${e?.message ?? e}`});
    }
  },

  // #261: guard + pick, but DON'T send — return the picked images so the composer
  // can stage them as removable thumbnails and send on the user's confirm.
  stageImages: async (convoPk: number) => {
    const convo = get().conversations[convoPk];
    if ((convo?.transport ?? 'logos') === 'mesh') {
      useNodeStore.setState({error: 'images are not supported on mesh'});
      return [];
    }
    if (useNodeStore.getState().status !== 'running') {
      useNodeStore.setState({error: 'Node is off or connecting. Make sure the node is online to send images'});
      return [];
    }
    try {
      return parsePickedArray(await ImagePicker.pickImages(1024, 60_000, MAX_ALBUM));
    } catch (e: any) {
      useNodeStore.setState({error: String(e?.message ?? e)});
      return [];
    }
  },

  stageCameraPhoto: async (convoPk: number) => {
    const convo = get().conversations[convoPk];
    if ((convo?.transport ?? 'logos') === 'mesh') {
      useNodeStore.setState({error: 'images are not supported on mesh'});
      return [];
    }
    if (useNodeStore.getState().status !== 'running') {
      useNodeStore.setState({error: 'Node is off or connecting. Make sure the node is online to send a photo'});
      return [];
    }
    if (!(await ensurePerm(PermissionsAndroid.PERMISSIONS.CAMERA))) {
      useNodeStore.setState({error: 'camera permission denied'});
      return [];
    }
    try {
      const p = parsePicked(await ImagePicker.capturePhoto(1024, 60_000));
      return p != null ? [p] : [];
    } catch (e: any) {
      useNodeStore.setState({error: String(e?.message ?? e)});
      return [];
    }
  },

  // #261: send images the user staged in the composer, each its own message.
  sendStagedImages: async (convoPk: number, images: PickedImage[]) => {
    for (const p of images) {
      try {
        const res = JSON.parse(
          await LogosChat.sendImageTo(convoPk, p.mime, p.width, p.height, p.base64),
        );
        if (res.status === 'failed') {
          useNodeStore.setState({error: 'image send failed — tap to retry'});
        }
      } catch (e: any) {
        useNodeStore.setState({error: String(e?.message ?? e)});
      }
    }
    await get().loadMessages(convoPk);
    get().refreshConversations();
  },

  // #255: acquire a fix but DON'T send — the composer previews it first.
  fetchLocation: async () => {
    if (
      !(await ensurePerm(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION))
    ) {
      useNodeStore.setState({error: 'location permission denied'});
      return null;
    }
    let loc;
    try {
      loc = parseNativeLocation(await LocationNative.getCurrent());
    } catch (e: any) {
      useNodeStore.setState({error: String(e?.message ?? e)});
      return null;
    }
    if (loc == null) {
      useNodeStore.setState({error: 'could not get location'});
      return null;
    }
    return loc;
  },

  // #255: send a location the user confirmed. Tiny text — routes through the
  // normal send (works on any transport).
  sendLocationValue: async (convoPk: number, loc: LatLng) => {
    await get().send(convoPk, buildLocation(loc));
  },

  // #204: kept as the fetch-then-send convenience (unused by the composer since
  // #255, which previews before sending).
  sendLocation: async (convoPk: number) => {
    const loc = await get().fetchLocation();
    if (loc == null) return;
    await get().sendLocationValue(convoPk, loc);
  },

  sendVoice: async (convoPk, rec) => {
    const convo = get().conversations[convoPk];
    if ((convo?.transport ?? 'logos') === 'mesh') {
      useNodeStore.setState({error: 'voice notes are not supported on mesh'});
      return;
    }
    if (useNodeStore.getState().status !== 'running') {
      useNodeStore.setState({error: 'Node is off or connecting. Make sure the node is online to send a voice note'});
      return;
    }
    try {
      const res = JSON.parse(
        await LogosChat.sendVoiceTo(
          convoPk,
          rec.mime,
          rec.durationMs,
          rec.waveform.join(','),
          rec.base64,
        ),
      );
      if (res.status === 'failed') {
        useNodeStore.setState({error: 'voice send failed — tap to retry'});
      }
    } catch (e: any) {
      useNodeStore.setState({error: String(e?.message ?? e)});
    }
    await get().loadMessages(convoPk);
    get().refreshConversations();
  },

  forwardMessage: async (content, toConvoPk) => {
    const target = get().conversations[toConvoPk];
    const targetMesh = (target?.transport ?? 'logos') === 'mesh';
    const img = parseImageLocal(content);
    const voc = parseVoiceLocal(content);
    const isMedia = img != null || voc != null;
    if (isMedia && targetMesh) {
      useNodeStore.setState({error: 'media cannot be forwarded to a mesh chat'});
      return;
    }
    try {
      if (img != null) {
        const base64 = await ImagePicker.readFileBase64(img.path);
        await LogosChat.sendImageTo(
          toConvoPk,
          img.meta.mime,
          img.meta.width,
          img.meta.height,
          base64,
        );
      } else if (voc != null) {
        const base64 = await ImagePicker.readFileBase64(voc.path);
        await LogosChat.sendVoiceTo(
          toConvoPk,
          voc.meta.mime,
          voc.meta.durationMs,
          voc.meta.waveform.join(','),
          base64,
        );
      } else {
        // Text or location — re-send the raw content through the normal path.
        await get().send(toConvoPk, content);
      }
    } catch (e: any) {
      useNodeStore.setState({error: String(e?.message ?? e)});
    }
  },

  sendReaction: async (convoPk, targetKey, emoji, op) => {
    // A reaction is just a message whose body is a react1: marker — reuse the whole
    // send path (transport routing, optimistic bubble, dedup). The optimistic row
    // is a marker, so it's filtered from the timeline + folded into reactions.
    await get().send(convoPk, encodeReaction(op, emoji, targetKey));
  },

  pinMessage: async (convoPk, targetKey, op) => {
    await get().send(convoPk, encodePin(op, targetKey));
  },

  send: async (convoPk: number, text: string) => {
    // #165 (docs/mesh-transport.md): route by the conversation's transport.
    // Undefined/'logos' → the Logos MLS node (unchanged). 'mesh' → a paired
    // MeshCore radio, wired in #166 (dormant: no mesh conversations exist yet).
    const convo = get().conversations[convoPk];
    const transport = convo?.transport ?? 'logos';
    // #168 (Phase 2c): a Logos group switched to its MeshCore mirror — sends ride
    // the private channel, but the conversation stays 'logos' (it IS an MLS group).
    const meshMirror =
      (convo?.isGroup ?? false) &&
      (convo?.meshMode ?? false) &&
      convo?.meshChannelIdx != null;
    const running = useNodeStore.getState().status === 'running';
    // #213: a 1:1 with a contact currently reachable over the BLE mesh sends over
    // BLE (encrypt once + flood) instead of the node — MLS still E2E-encrypts; BLE
    // is just the pipe. (Noise link-auth #136 layers on later.) Lazy require breaks
    // the bleStore↔chatStore import cycle.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {useBleStore} = require('./bleStore');
    const blePeer =
      convo && !convo.isGroup ? convo.peerAddress?.toLowerCase() : undefined;
    const bleReachable =
      blePeer != null &&
      useBleStore.getState().status === 'on' &&
      useBleStore
        .getState()
        .nearbyContacts.some((a: string) => a.toLowerCase() === blePeer);
    const via: 'logos' | 'mesh' | 'ble' = bleReachable
      ? 'ble'
      : transport === 'mesh' || meshMirror
        ? 'mesh'
        : 'logos';
    // Optimistic pending bubble; the durable row lands native-side and the
    // reload below replaces this. sentVia matches the transport actually used.
    const temp: MessageRow = {
      msgPk: -Date.now(),
      direction: 'out',
      text,
      at: Date.now(),
      status: 'pending',
      senderAccount: null,
      sentVia: via,
    };
    set(s => ({
      messages: {...s.messages, [convoPk]: [temp, ...(s.messages[convoPk] ?? [])]},
    }));
    try {
      if (bleReachable) {
        // #213: encrypt ONCE off-node (records the sender's bubble native-side +
        // returns the wire bytes), then flood the base64 ciphertext over the BLE
        // mesh. The peer's inbound handler reassembles + ingestCiphertext → its
        // timeline. No node involved.
        const res = JSON.parse(await LogosChat.encryptForConvo(convoPk, text));
        await useBleStore.getState().sendCiphertext(res.dataB64);
      } else if (transport === 'mesh') {
        // #167: a mesh conversation is either a channel ("mesh:chan:<idx>") or an
        // ECDH DM ("mesh:dm:<pubkeyHex>"). Route to the matching MeshCore verb.
        // #150: a LoRa text packet is byte-capped — send the first part that fits
        // (never split a multi-byte char) rather than overflow the radio.
        const meshText = truncateToBytes(text, MESH_TEXT_MTU_BYTES);
        const libId = convo?.libConvoId ?? '';
        const chan = libId.match(/^mesh:chan:(\d+)$/);
        const dm = libId.match(/^mesh:dm:([0-9a-fA-F]+)$/);
        if (chan != null) {
          await MeshCore.sendChannelText(parseInt(chan[1], 10), meshText);
        } else if (dm != null) {
          await MeshCore.sendDm(dm[1], meshText);
        } else {
          throw new Error('unsupported mesh conversation');
        }
        // Persist to the shared timeline what actually went over the radio (the
        // optimistic bubble is replaced below).
        await LogosChat.recordMeshMessage(convoPk, 'out', meshText, Date.now(), null);
      } else if (meshMirror) {
        // #168 (dual-send): mirroring is ADDITIVE — send on EVERY *live* transport
        // so Logos-only AND mesh-only members both receive. The mesh leg is
        // BEST-EFFORT: only attempt it when the radio is actually connected, and a
        // mesh failure must NOT abort the Logos leg (the bug: a down radio threw
        // and the Logos send never ran → "no radio connected", nothing delivered).
        const idx = convo!.meshChannelIdx!;
        const meshConnected = useMeshStore.getState().status === 'connected';
        // #150: the LoRa leg is byte-capped; the Logos leg below carries the FULL
        // text (no radio MTU), so Logos members get everything and radio-only
        // members get the first part that fits.
        const meshText = truncateToBytes(text, MESH_TEXT_MTU_BYTES);
        let meshOk = false;
        if (meshConnected) {
          try {
            await MeshCore.sendChannelText(idx, meshText);
            meshOk = true;
          } catch {
            // radio hiccup — Logos still carries below if the node is up
          }
        }
        if (running) {
          const res = JSON.parse(await LogosChat.sendMessageTo(convoPk, text));
          if (res.status === 'failed') {
            useNodeStore.setState({error: 'send failed — tap the message to retry'});
          }
        } else if (meshOk) {
          // Node down but the mesh leg went — record the mesh-only outbound (what
          // actually left over the radio).
          await LogosChat.recordMeshMessage(convoPk, 'out', meshText, Date.now(), null);
        } else {
          // Neither transport carried it (onSubmit normally gates this).
          throw new Error('no transport available — connect the radio or the node');
        }
      } else if (!running) {
        // #237: Logos delivery is paused ("off") and this peer is not reachable
        // over BLE (bleReachable) or mesh — refuse instead of calling the node's
        // publish, which is now a no-op while paused (would look "sent" but go
        // nowhere). onSubmit normally gates this; this is the store-side backstop.
        throw new Error('Logos is off — this contact isn’t reachable over Bluetooth');
      } else {
        const res = JSON.parse(await LogosChat.sendMessageTo(convoPk, text));
        if (res.status === 'failed') {
          useNodeStore.setState({error: 'send failed — tap the message to retry'});
        }
      }
    } catch (e: any) {
      set(s => ({
        messages: {
          ...s.messages,
          [convoPk]: (s.messages[convoPk] ?? []).filter(m => m.msgPk !== temp.msgPk),
        },
      }));
      throw e;
    }
    await get().loadMessages(convoPk);
    await get().refreshConversations();
  },

  retry: async (convoPk: number, msgPk: number) => {
    try {
      const res = JSON.parse(await LogosChat.retryMessage(msgPk));
      if (res.status === 'failed') {
        // Don't blame the node — it is usually healthy here. A repeat failure
        // now means the route could not be re-established for this peer.
        useNodeStore.setState({
          error: 'still could not send — the contact may be unreachable',
        });
      }
    } finally {
      await get().loadMessages(convoPk);
    }
  },

  setActive: (convoPk: number | null) => {
    set({activeConvoPk: convoPk});
    LogosChat.setActiveConversation(convoPk ?? 0);
    if (convoPk != null) {
      get().markRead(convoPk);
    }
  },

  markRead: (convoPk: number) => {
    LogosChat.markRead(convoPk).then(() => get().refreshConversations());
  },

  setNickname: async (convoPk: number, name: string) => {
    await LogosChat.setNickname(convoPk, name);
    await get().refreshConversations();
  },

  setVerified: async (convoPk: number, verified: boolean) => {
    await LogosChat.setVerified(convoPk, verified);
    await get().refreshConversations();
  },

  wipe: async (convoPk: number) => {
    await LogosChat.wipeConversationContent(convoPk);
    set(s => ({messages: {...s.messages, [convoPk]: []}}));
    await get().refreshConversations();
  },

  pushSystemLine: (
    convoPk: number,
    text: string,
    info?: string,
    infoAddress?: string,
  ) => {
    const note: SystemNote = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      at: Date.now(),
      info,
      infoAddress,
    };
    set(s => {
      const existing = s.systemLines[convoPk] ?? [];
      // #252: don't stack a consecutive duplicate plain note — e.g. two
      // "Group re-created" back-to-back (recreate firing on both the local
      // action and a members_changed reload). Member lines (member != null)
      // upsert elsewhere, so only guard ordinary notes.
      const last = existing[existing.length - 1];
      if (last != null && last.text === text && last.member == null && info == null) {
        return {};
      }
      // #228: cap + PERSIST so invited/joined lines survive an app restart (they
      // were UI-only before, so every reinstall/relaunch wiped them — which read
      // as "no invite ever happened").
      const next = [...existing, note].slice(-SYSLINE_CAP);
      persistSystemLines(convoPk, next);
      return {systemLines: {...s.systemLines, [convoPk]: next}};
    });
  },

  setMemberStatus: (convoPk, address, status, at) => {
    const fields = memberStatusFields(address, status, describePeer(address));
    const member = address.toLowerCase();
    set(s => {
      const cur = s.systemLines[convoPk] ?? [];
      const prior = cur.find(n => n.member === member);
      // #285/#288: the same status can be re-fired repeatedly (members_changed
      // + member_joined arrive per commit/message during group formation). An
      // identical re-fire must NOT touch the note — otherwise it re-stamps `at`
      // and the single "joined" line jumps below every new message. Only a real
      // status change (different text) or an explicit `at` override updates it.
      if (prior != null && prior.text === fields.text && at == null) {
        return {};
      }
      const note = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        // Keep the member's original timestamp when advancing its line
        // (invited → joined) so it stays anchored in history instead of
        // floating to the bottom; an explicit `at` (#252) still wins.
        at: at ?? prior?.at ?? Date.now(),
        ...fields,
      };
      // Upsert by member so the status advances in place (invited → hasn't
      // joined → joined) with no stacking.
      const next = upsertMemberNote(cur, note, SYSLINE_CAP);
      persistSystemLines(convoPk, next);
      return {systemLines: {...s.systemLines, [convoPk]: next}};
    });
  },

  clearMemberStatuses: convoPk => {
    set(s => {
      const cur = s.systemLines[convoPk];
      if (cur == null) return {};
      const next = clearMemberNotes(cur);
      persistSystemLines(convoPk, next);
      return {systemLines: {...s.systemLines, [convoPk]: next}};
    });
  },

  hydrateSystemLines: async (convoPk: number) => {
    // Already in memory (pushed this session) → nothing to load.
    if (get().systemLines[convoPk] != null) return;
    try {
      const raw = await LogosChat.getSetting(sysLineKey(convoPk));
      if (raw == null || raw.length === 0) return;
      const arr = JSON.parse(raw) as SystemNote[];
      if (!Array.isArray(arr)) return;
      // Don't clobber notes pushed while we were awaiting.
      set(s =>
        s.systemLines[convoPk] != null
          ? {}
          : {systemLines: {...s.systemLines, [convoPk]: arr}},
      );
    } catch {
      // corrupt/missing KV — start fresh, non-fatal.
    }
  },

  // #344: creator-only — flip a group's storage on/off. Guard on createdByMe (the
  // only per-conversation "am I the creator" signal we store; there is no creator
  // ADDRESS persisted, hence the trusted-community MVP caveat on the inbound fold).
  // Broadcast a gcfg1: marker so members enforce it, set state, and persist to KV.
  setGroupStorage: async (convoPk: number, off: boolean) => {
    const convo = get().conversations[convoPk];
    if (!convo?.createdByMe) return; // creator-gated
    // #344: announce the transition once (guard on an actual change — undefined
    // normalises to storage-on/off=false, the default — so an idempotent re-set is
    // silent). pushSystemLine also dedups consecutive dupes as a backstop.
    const wasOff = get().storageOff[convoPk] ?? false;
    set(s => ({storageOff: {...s.storageOff, [convoPk]: off}}));
    persistGroupStorage(convoPk, off);
    if (wasOff !== off) {
      get().pushSystemLine(
        convoPk,
        off
          ? 'Storage turned off — text & voice only'
          : 'Storage turned on — media enabled',
      );
    }
    try {
      await get().send(convoPk, encodeGroupCfg({storageOff: off}));
    } catch (e: any) {
      useNodeStore.setState({error: `couldn't update storage setting: ${e?.message ?? e}`});
    }
  },

  hydrateGroupStorage: async (convoPk: number) => {
    // Already in memory (set/folded this session) → nothing to load.
    if (get().storageOff[convoPk] != null) return;
    try {
      const raw = await LogosChat.getSetting(gcfgKey(convoPk));
      if (raw == null || raw.length === 0) return;
      const off = raw === 'off';
      set(s =>
        s.storageOff[convoPk] != null
          ? {}
          : {storageOff: {...s.storageOff, [convoPk]: off}},
      );
    } catch {
      // corrupt/missing KV — treat as storage on (default), non-fatal.
    }
  },

  probeGroup: async (convoPk: number) => {
    const state = await LogosChat.groupLiveness(convoPk);
    set(s => ({liveness: {...s.liveness, [convoPk]: state}}));
    return state;
  },

  recreateGroup: async (convoPk: number) => {
    const res = JSON.parse(await LogosChat.recreateGroup(convoPk));
    // The group is operable again on the NEW lib conversation.
    set(s => ({liveness: {...s.liveness, [convoPk]: 'live'}}));
    // #230: a fresh round — drop stale per-member status lines so the re-invite
    // doesn't stack a new "invited/hasn't joined" under every old one.
    get().clearMemberStatuses(convoPk);
    get().pushSystemLine(convoPk, 'Group re-created');
    // Re-invite from JS (not native) so EVERY member gets its own
    // "<label> <hex> invited" line, and later its own "joined" line.
    const roster: string[] = res.members ?? [];
    let invited = 0;
    for (const address of roster) {
      try {
        await get().addMember(convoPk, address);
        invited += 1;
      } catch {
        get().pushSystemLine(convoPk, `${describePeer(address)} could not be invited`);
      }
    }
    await get().refreshConversations();
    return {invited, total: roster.length};
  },

  reviveAndSend: async (convoPk: number, text: string) => {
    const res = await get().recreateGroup(convoPk);
    if (res.invited === 0) {
      // Nobody to wait for — send immediately.
      await get().send(convoPk, text);
      return res;
    }
    await waitForJoin(convoPk);
    await get().send(convoPk, text);
    return res;
  },

  leaveGroup: async (convoPk: number) => {
    // #283: GroupV1 has no cryptographic self-remove (the old `leaveGroup` MLS
    // round errors on a V1 group). So leaving is: (1) broadcast a `leave1:` marker
    // so the other members see us leave + drop us from their roster; (2) tombstone
    // the lib id + delete locally so the group never reappears (we still receive
    // its traffic). Best-effort marker — if we're offline we still leave locally.
    try {
      await get().send(convoPk, encodeLeave());
    } catch {
      // offline / send failed — leave locally anyway
    }
    await LogosChat.leaveGroupLocal(convoPk);
    // JS-side cleanup (native already deleted the row + messages).
    for (const p of pendingInvites[convoPk] ?? []) clearTimeout(p.timer);
    delete pendingInvites[convoPk];
    delete pendingJoins[convoPk];
    LogosChat.setSetting(sysLineKey(convoPk), '').catch(() => {});
    set(s => {
      const conversations = {...s.conversations};
      delete conversations[convoPk];
      const messages = {...s.messages};
      delete messages[convoPk];
      const members = {...s.members};
      delete members[convoPk];
      const systemLines = {...s.systemLines};
      delete systemLines[convoPk];
      return {conversations, messages, members, systemLines};
    });
  },

  deleteMessage: async (convoPk: number, msgPk: number) => {
    // Local-only delete (no remote unsend). Drop from the DB, then from the
    // in-memory timeline so the bubble disappears immediately.
    await LogosChat.deleteMessage(msgPk);
    set(s => ({
      messages: {
        ...s.messages,
        [convoPk]: (s.messages[convoPk] ?? []).filter(m => m.msgPk !== msgPk),
      },
    }));
  },

  remove: async (convoPk: number) => {
    await LogosChat.deleteConversation(convoPk);
    // #195: don't let a pending "hasn't joined" timeout fire on a deleted thread.
    for (const p of pendingInvites[convoPk] ?? []) {
      clearTimeout(p.timer);
    }
    delete pendingInvites[convoPk];
    delete pendingJoins[convoPk];
    // #228: drop the persisted system notes for the removed thread.
    LogosChat.setSetting(sysLineKey(convoPk), '').catch(() => {});
    set(s => {
      const conversations = {...s.conversations};
      delete conversations[convoPk];
      const messages = {...s.messages};
      delete messages[convoPk];
      const members = {...s.members};
      delete members[convoPk];
      const systemLines = {...s.systemLines};
      delete systemLines[convoPk];
      return {conversations, messages, members, systemLines};
    });
  },

  openMeshChannel: async (idx: number, name: string) => {
    const convoPk = await LogosChat.upsertMeshChannel(idx, name);
    await get().refreshConversations();
    await get().loadMessages(convoPk);
    return convoPk;
  },

  startMeshDm: async (pubkeyHex: string, name: string | null) => {
    // Reconcile with a placeholder row the inbound path may have created from the
    // peer's 6-byte prefix, so a peer-initiated DM and a contact-initiated one
    // converge on a single thread (sendDm only uses the first 6 bytes anyway).
    const existing = await LogosChat.meshDmByPrefix(pubkeyHex.slice(0, 12));
    const convoPk =
      existing >= 0 ? existing : await LogosChat.upsertMeshDm(pubkeyHex, name);
    await get().refreshConversations();
    await get().loadMessages(convoPk);
    return convoPk;
  },
}));

// #167: inbound MeshCore channel messages → persist into the shared timeline and
// refresh. The channel's display name comes from meshStore if we know it, else a
// sensible default (idx 0 is the public channel).
addMeshListener(e => {
  const channelIdx = e.channelIdx;
  const text = e.text;
  const at = e.at;
  if (e.eventType !== 'channelMessage' || channelIdx == null || text == null || at == null) {
    return;
  }
  (async () => {
    try {
      // #168 (Phase 2c): if this channel is a Logos group's mesh mirror, land the
      // message in the GROUP's timeline (not a standalone channel convo).
      const mirroredGroup = await LogosChat.groupForMeshChannel(channelIdx);
      const convoPk =
        mirroredGroup >= 0
          ? mirroredGroup
          : await LogosChat.upsertMeshChannel(
              channelIdx,
              channelIdx === 0 ? 'Public' : `Channel ${channelIdx}`,
            );
      const fromName = e.fromName && e.fromName.length > 0 ? e.fromName : null;
      await LogosChat.recordMeshMessage(convoPk, 'in', text, at, fromName);

      // #168 mesh→logos re-forward: if this channel mirrors a Logos group and
      // the node is running, relay the message into the group so Logos-only
      // members (who have no radio) see it — attributed to the mesh sender via
      // an envelope. Loop guards: never re-forward an already-relayed envelope,
      // and never re-forward our OWN radio's traffic (a channel echo of our own
      // send would otherwise bounce into Logos).
      const meshSelf = useMeshStore.getState().selfName;
      const nodeRunning = useNodeStore.getState().status === 'running';
      if (
        mirroredGroup >= 0 &&
        nodeRunning &&
        !isRelay(text) &&
        (fromName == null || fromName !== meshSelf)
      ) {
        try {
          await LogosChat.relayToLogos(
            mirroredGroup,
            wrapRelay(fromName ?? 'mesh', text),
          );
        } catch {
          // a relay failure must not break local persistence of the message
        }
      }

      await useChatStore.getState().refreshConversations();
      if (useChatStore.getState().activeConvoPk === convoPk) {
        await useChatStore.getState().loadMessages(convoPk);
      }
    } catch {
      // best-effort: a persistence hiccup shouldn't crash the event pump
    }
  })();
});

// #167 (Phase 1b): inbound MeshCore ECDH DMs → persist into the shared timeline.
// The frame carries only the sender's 6-byte pubkey PREFIX, so we reconcile against
// any existing DM row via meshDmByPrefix; unknown senders get a placeholder row
// keyed by the prefix (a later contact-initiated DM converges on it, see startMeshDm).
addMeshListener(e => {
  if (e.eventType !== 'dmMessage') {
    return;
  }
  const prefix = e.fromPubkeyPrefixHex;
  const text = e.text;
  const at = e.at;
  if (prefix == null || text == null || at == null) {
    return;
  }
  (async () => {
    try {
      // #168 (Phase 2c): a group-mirror INVITE ("lmi:<idx>:<key>:<name>") is a
      // control message, not chat — auto-join the channel so the mirror flows in,
      // and don't render it as a DM bubble.
      if (text.startsWith(MESH_INVITE_PREFIX)) {
        const body = text.slice(MESH_INVITE_PREFIX.length);
        // New format carries the group's lib id: idx:key(32hex):libId(hex):name.
        // Fall back to the old idx:key:name (no binding possible).
        let inviteIdx = -1;
        let key: string | null = null;
        let libId: string | null = null;
        let rawName = '';
        let m = body.match(/^(\d+):([0-9a-fA-F]{32}):([0-9a-fA-F]*):(.*)$/);
        if (m != null) {
          inviteIdx = parseInt(m[1], 10);
          key = m[2].toLowerCase();
          libId = m[3].length > 0 ? m[3].toLowerCase() : null;
          rawName = m[4];
        } else {
          m = body.match(/^(\d+):([0-9a-fA-F]{32}):(.*)$/);
          if (m != null) {
            inviteIdx = parseInt(m[1], 10);
            key = m[2].toLowerCase();
            rawName = m[3];
          }
        }
        if (key != null) {
          const inviteName = rawName.length > 0 ? rawName : `Channel ${inviteIdx}`;
          // #168 Bug 1: if we already hold the mirrored Logos group locally, bind
          // this channel to it FIRST, so inbound mesh lands in the group timeline
          // rather than a standalone channel. (Race: if the group welcome hasn't
          // arrived yet, we fall through to a standalone channel — rare, since
          // the Logos welcome normally precedes the mesh invite in the flow.)
          if (libId != null) {
            const g = Object.values(
              useChatStore.getState().conversations,
            ).find(c => c.isGroup && c.libConvoId?.toLowerCase() === libId);
            if (g != null) {
              await LogosChat.setMeshMirror(g.convoPk, inviteIdx, key);
            }
          }
          await MeshCore.setChannel(inviteIdx, inviteName, key);
          await useChatStore.getState().refreshConversations();
          return;
        }
      }
      const found = await LogosChat.meshDmByPrefix(prefix);
      const name = e.fromName && e.fromName.length > 0 ? e.fromName : null;
      const convoPk =
        found >= 0 ? found : await LogosChat.upsertMeshDm(prefix, name);
      await LogosChat.recordMeshMessage(convoPk, 'in', text, at, name);
      await useChatStore.getState().refreshConversations();
      if (useChatStore.getState().activeConvoPk === convoPk) {
        await useChatStore.getState().loadMessages(convoPk);
      }
    } catch {
      // best-effort: a persistence hiccup shouldn't crash the event pump
    }
  })();
});

/**
 * Resolve when the invitee's join commits for `convoPk` (a members_changed for
 * that conversation), or after `timeoutMs` so a message is never stuck forever.
 */
const joinWaiters: Record<number, Array<() => void>> = {};

/**
 * After `members_changed` the joiner has NOT necessarily subscribed yet: it
 * subscribes to the group's delivery topic only once it processes the welcome,
 * which we measured landing ~2s AFTER our members_changed. Anything published in
 * that window is never delivered (a subscription race, not a crypto one — there
 * is no store replay for this topic). Settle before flushing a held message.
 */
const JOIN_SETTLE_MS = 8_000;

function waitForJoin(convoPk: number, timeoutMs = 120_000): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    // The join signal starts the settle window; the timeout is the hard cap.
    (joinWaiters[convoPk] ??= []).push(() => setTimeout(finish, JOIN_SETTLE_MS));
    setTimeout(finish, timeoutMs);
  });
}

function notifyJoin(convoPk: number) {
  const waiters = joinWaiters[convoPk];
  if (waiters == null) return;
  delete joinWaiters[convoPk];
  for (const w of waiters) w();
}

// ---------------------------------------------------------------------------
// Live refresh: every persisted change arrives as a db_changed event AFTER the
// SQLite write. Initial load happens on module import.

addLogosChatListener(e => {
  const s = useChatStore.getState();
  // #348: the lib reports we're stuck on an old MLS epoch and can't recover
  // in-band (a persistent future-epoch stall, not transient out-of-order). This
  // event carries no durable state (handleLibEvent returns null), so it is only
  // ever the raw 'lib' push — surface a tappable "you've fallen out of sync"
  // notice so the user can ask a still-reachable member to re-add them.
  if (e.source === 'lib' && e.eventType === 'group_desynced') {
    let libConvoId: string | null = null;
    try {
      libConvoId = JSON.parse(e.event ?? '{}').convoId ?? null;
    } catch {
      // malformed payload — nothing to resolve.
    }
    if (libConvoId != null) {
      const convo = Object.values(s.conversations).find(
        c => c.libConvoId === libConvoId,
      );
      if (convo != null) {
        const convoPk = convo.convoPk;
        // Don't restack: one desync notice per thread (native edge-triggers, but
        // a persisted line could otherwise re-append on a later fire).
        const already = (s.systemLines[convoPk] ?? []).some(
          n => n.info === 'desynced',
        );
        if (!already) {
          const me = useNodeStore.getState().myAddress?.toLowerCase();
          // Best-effort re-add contact: the first non-self group member (there is
          // no stored "creator" flag — any member can re-add us). Falls back to
          // undefined, in which case the notice is shown without a tap target.
          const pushDesync = () => {
            const roster = useChatStore.getState().members[convoPk] ?? [];
            const target = roster.find(
              m => !m.isSelf && m.address.toLowerCase() !== me,
            );
            useChatStore
              .getState()
              .pushSystemLine(
                convoPk,
                "You've fallen out of sync — ask to be re-added",
                'desynced',
                target?.address,
              );
          };
          if (s.members[convoPk] != null) {
            pushDesync();
          } else {
            s.loadMembers(convoPk).then(pushDesync).catch(pushDesync);
          }
        }
      }
    }
    return;
  }
  if (e.source === 'repo' && e.eventType === 'db_changed') {
    // #252: a JOINER just joined/rejoined a group (group_ready fires only on the
    // joiner — the creator makes the group directly). Auto-send a join-ack so the
    // creator learns immediately; MLS gives the adder no signal until a member
    // transmits. Delay past the subscription-settle window (#192) so it delivers,
    // and only once per convo per session.
    if (e.kind === 'group_ready' && e.convoPk != null) {
      const convoPk = e.convoPk;
      if (!ackedGroups.has(convoPk)) {
        ackedGroups.add(convoPk);
        setTimeout(() => {
          LogosChat.sendJoinAck(convoPk).catch(() => ackedGroups.delete(convoPk));
        }, JOIN_SETTLE_MS + 500);
      }
      // #252: everyone already in the group when I join is an established member
      // (the welcome carries the current roster). Mark them "joined" now — the
      // CREATOR never sends a join-ack (it doesn't get group_ready), so this is
      // how a joiner learns the creator + pre-existing members are in, instead of
      // waiting for each of them to send a message.
      const me = useNodeStore.getState().myAddress?.toLowerCase();
      s.loadMembers(convoPk)
        .then(() => {
          const st = useChatStore.getState();
          const roster = st.members[convoPk] ?? [];
          const at = st.conversations[convoPk]?.createdAt;
          for (const m of roster) {
            if (m.address.toLowerCase() !== me) {
              st.setMemberStatus(convoPk, m.address, 'joined', at);
            }
          }
        })
        .catch(() => {});
    }
    // #252: a member's join-ack arrived → mark them joined (ground truth, no
    // bubble). Clears a stale "invited"/"hasn't joined" the members_changed path
    // missed for a re-invited same-identity member.
    if (e.kind === 'member_joined' && e.convoPk != null && e.sender != null) {
      const convoPk = e.convoPk;
      const sender = e.sender.toLowerCase();
      clearPendingInvite(convoPk, sender);
      // On a JOINER (!createdByMe), sort the "joined" line at the group's start
      // (not ack-arrival time) — a late creator ack must not land AFTER messages
      // that member already sent. On the CREATOR, keep now-time (its timeline is
      // already correct: it saw the invitee join in real order).
      const convo = s.conversations[convoPk];
      const at = convo != null && !convo.createdByMe ? convo.createdAt : undefined;
      s.setMemberStatus(convoPk, e.sender, 'joined', at);
      // Re-announce ourselves to this newly-seen member so they learn we're in —
      // this is how a fresh joiner discovers the CREATOR (which sent no initial
      // ack). Once per new member, throttled per group to avoid an ack storm.
      const me = useNodeStore.getState().myAddress?.toLowerCase();
      const g = (rebroadcast[convoPk] ??= {seen: new Set<string>(), at: 0});
      if (sender !== me && !g.seen.has(sender)) {
        g.seen.add(sender);
        const now = Date.now();
        if (now - g.at > 4000) {
          g.at = now;
          LogosChat.sendJoinAck(convoPk).catch(() => {});
        }
      }
    }
    // #112: the invitee's join committed — release any message held for it.
    if (e.kind === 'members_changed' && e.convoPk != null) {
      const convoPk = e.convoPk;
      // #116: anyone the lib roster diff found missing → "<x> left".
      let hadLeft = false;
      if (e.detail != null && e.detail.length > 0) {
        try {
          const left: string[] = JSON.parse(e.detail).left ?? [];
          hadLeft = left.length > 0;
          for (const addr of left) {
            clearPendingInvite(convoPk, addr.toLowerCase());
            s.setMemberStatus(convoPk, addr, 'left');
          }
        } catch {
          // malformed detail — ignore, the roster is still reconciled native-side.
        }
      }
      // #228/#230: mark whoever joined. Two signals, both idempotent because
      // setMemberStatus upserts by member (a member marked "joined" twice still
      // shows one line):
      //   (1) ROSTER DIFF — a member newly present in the roster (the remote
      //       joiner's own admission, or a join the creator hadn't yet listed).
      //   (2) FIFO FALLBACK — on the CREATOR, addMember pre-loads the invitee
      //       into the roster at invite time, so the later join produces NO diff;
      //       treat this members_changed as the oldest outstanding invite settling.
      const prevRoster = useChatStore.getState().members[convoPk];
      const prev = new Set((prevRoster ?? []).map(m => m.address.toLowerCase()));
      s.loadMembers(convoPk)
        .then(() => {
          if (prevRoster == null) return; // first time we learned the roster — seed only
          const cur = useChatStore.getState().members[convoPk] ?? [];
          const st = useChatStore.getState();
          let announced = false;
          for (const m of cur) {
            const a = m.address.toLowerCase();
            if (!prev.has(a)) {
              clearPendingInvite(convoPk, a); // cancel its "hasn't joined" timeout
              st.setMemberStatus(convoPk, m.address, 'joined');
              const jq = pendingJoins[convoPk];
              if (jq != null) {
                const j = jq.indexOf(a);
                if (j >= 0) jq.splice(j, 1);
              }
              announced = true;
            }
          }
          // (2) No new roster entry but an invite is outstanding → the creator's
          // pre-added invitee just settled. Announce the oldest one FIFO. Skip
          // when this event was a "left" — that shrinks the roster, and must not
          // be mis-read as a pending invite joining.
          if (!announced && !hadLeft) {
            const jq = pendingJoins[convoPk];
            const addr = jq?.shift();
            if (addr != null) {
              clearPendingInvite(convoPk, addr);
              st.setMemberStatus(convoPk, addr, 'joined');
            }
          }
        })
        .catch(() => {});
      notifyJoin(convoPk);
    }
    // #168 logos→mesh re-forward: an inbound Logos group message on a
    // mesh-mirrored group is relayed onto the mesh channel so mesh-only members
    // (who have no Logos node) see it — attributed to its Logos sender via an
    // envelope. `detail` is the content, `sender` the author (both added
    // natively). Inbound is never our own (MLS drops our echo), and this
    // db_changed 'message' only fires on the Logos path (recordMeshMessage emits
    // nothing), so a mesh-origin message never bounces back onto mesh. Loop
    // guard: never re-forward an already-relayed envelope.
    if (
      e.kind === 'message' &&
      e.direction === 'in' &&
      e.convoPk != null &&
      e.detail != null &&
      !isRelay(e.detail) &&
      // #197: images can't fit a LoRa datagram — never mirror them to the mesh.
      !isImageContent(e.detail)
    ) {
      const convo = s.conversations[e.convoPk];
      if (
        convo?.isGroup &&
        convo.meshMode &&
        convo.meshChannelIdx != null &&
        useMeshStore.getState().status === 'connected'
      ) {
        const label = e.sender != null ? describePeer(e.sender) : 'logos';
        // The LoRa datagram is ~133 chars, single-shot; the envelope prefix +
        // label eat into that, so truncate the relayed text to what fits.
        const budget = Math.max(0, 120 - label.length);
        const body =
          e.detail.length > budget ? `${e.detail.slice(0, budget - 1)}…` : e.detail;
        MeshCore.sendChannelText(convo.meshChannelIdx, wrapRelay(label, body)).catch(
          () => {
            // a relay failure must not break local handling of the message
          },
        );
      }
    }
    // #252: a group member who SENDS a message has unambiguously joined — resolve
    // any stale "invited"/"hasn't joined" line for them. This is the reliable
    // ground-truth signal a re-invited member's join needs: on recreate the
    // creator pre-loads invitees into the roster (no roster diff) and the #195
    // window may have already flipped them to "hasn't joined", so the members_changed
    // path can miss a late same-identity rejoin — but their first message can't.
    // Idempotent (setMemberStatus upserts by member).
    if (
      e.kind === 'message' &&
      e.direction === 'in' &&
      e.convoPk != null &&
      e.sender != null
    ) {
      const convo = s.conversations[e.convoPk];
      if (convo?.isGroup) {
        clearPendingInvite(e.convoPk, e.sender.toLowerCase());
        s.setMemberStatus(e.convoPk, e.sender, 'joined');
      }
    }
    // #314: an inbound pfp1: marker announces a contact's custom avatar. Cache it (keyed by
    // sender) + persist so HexAvatar renders it in place of the identicon. It's a folded
    // marker, never a bubble — native suppression keeps it out of notify/preview/unread, and
    // the ChatScreen fold keeps it out of the timeline.
    if (
      e.kind === 'message' &&
      e.direction === 'in' &&
      e.sender != null &&
      e.detail != null &&
      isPfpContent(e.detail)
    ) {
      if (isPfpClear(e.detail)) {
        // #314: the peer removed their avatar → drop the cached photo.
        useAvatarStore.getState().clearContactAvatar(e.sender);
      } else {
        const ref = parsePfp(e.detail);
        if (ref != null) {
          useAvatarStore.getState().setContactAvatar(e.sender, ref);
        }
      }
    }
    // #344: an inbound gcfg1: marker announces the group's storage on/off choice.
    // Honor the newest (this event IS the newest for its convo). MVP caveat: for a
    // trusted community we do NOT hard-verify sender==creator here — no creator
    // ADDRESS is stored, only a local createdByMe flag — so any member's gcfg1:
    // marker is honored. Residual: a malicious member could flip the flag (a
    // usability regression, not a storage leak — it can only make the group MORE
    // restrictive; media a member declines to send is never uploaded). Folded
    // control message, never a bubble (native + timeline suppression).
    if (
      e.kind === 'message' &&
      e.direction === 'in' &&
      e.convoPk != null &&
      e.detail != null &&
      isGroupCfgContent(e.detail)
    ) {
      const cfg = parseGroupCfg(e.detail);
      if (cfg != null) {
        const convoPk = e.convoPk;
        // #344: a live inbound marker is a real transition (a member sees the
        // creator's flip) — announce it once, guarded on an actual change.
        const wasOff = useChatStore.getState().storageOff[convoPk] ?? false;
        useChatStore.setState(st => ({
          storageOff: {...st.storageOff, [convoPk]: cfg.storageOff},
        }));
        persistGroupStorage(convoPk, cfg.storageOff);
        if (wasOff !== cfg.storageOff) {
          useChatStore
            .getState()
            .pushSystemLine(
              convoPk,
              cfg.storageOff
                ? 'Storage turned off — text & voice only'
                : 'Storage turned on — media enabled',
            );
        }
      }
    }
    s.refreshConversations();
    if (e.convoPk != null && e.convoPk === s.activeConvoPk) {
      s.loadMessages(e.convoPk);
      s.markRead(e.convoPk);
    }
  } else if (e.eventType === 'node_status') {
    s.refreshConversations();
  }
});

useChatStore.getState().refreshConversations();

// #308: native compress/upload progress → update the matching in-flight media send.
// The transcoder emits many events per second; delivered in a synchronous batch they
// tripped React's nested-update guard ("Maximum update depth exceeded"). So we COALESCE:
// buffer the latest progress per id and flush at most once per animation frame, and only
// call setState when something actually changed (a no-op partial still notifies zustand).
let pendingProgress: Record<string, {phase: 'compressing' | 'sending'; progress: number}> = {};
let progressScheduled = false;
function flushMediaProgress() {
  progressScheduled = false;
  const updates = pendingProgress;
  pendingProgress = {};
  const cur = useChatStore.getState().mediaSends;
  let changed = false;
  const next = {...cur};
  for (const id of Object.keys(updates)) {
    if (next[id] == null) continue; // send already completed/cleared
    next[id] = {...next[id], phase: updates[id].phase, progress: updates[id].progress};
    changed = true;
  }
  if (changed) useChatStore.setState({mediaSends: next});
}
DeviceEventEmitter.addListener(
  'mediaProgress',
  (e: {id: string; phase: 'compressing' | 'sending'; progress: number}) => {
    pendingProgress[e.id] = {phase: e.phase, progress: e.progress};
    if (!progressScheduled) {
      progressScheduled = true;
      requestAnimationFrame(flushMediaProgress);
    }
  },
);
