// Chat thread. Inverted list over the DURABLE history (SQLite via chatStore);
// peer bubbles left, own right; optimistic 'pending' (dimmed) on sends; failed
// bubbles are tappable → retry. NO "delivered" ticks.
//
// Affordances (#104 #105 #106 #107 #109): every per-thread action lives behind
// ONE header overflow menu, and every per-message action behind a long-press on
// the bubble. Nothing is edited by tapping a label any more (#106) — a title
// that silently opened a modal was undiscoverable and easy to hit by accident.
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Alert,
  Animated,
  DeviceEventEmitter,
  Easing,
  Image,
  Linking,
  Text,
  TextInput,
  View,
  Pressable,
  FlatList,
  ScrollView,
  KeyboardAvoidingView,
  Modal,
  PermissionsAndroid,
  Platform,
  ToastAndroid,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import {useRoute, useFocusEffect, useNavigation} from '@react-navigation/native';
import type {RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {colors, type, spacing, radii, layout} from '../theme';
import {ErrorToast} from '../components/ErrorToast';
import {ActionButton} from '../components/ActionButton';
import {HexAvatar, avatarSeed, convoKind, type AvatarKind} from '../components/HexAvatar';
import {VerifiedBadge} from '../components/VerifiedBadge';
import {SystemLine} from '../components/SystemLine';
import {TrashIcon} from '../components/TrashIcon';
import {QrIcon} from '../components/QrIcon';
import {SendIcon} from '../components/SendIcon';
import {ImageIcon} from '../components/ImageIcon';
import {
  OverflowMenu,
  EllipsisIcon,
  BackIcon,
  TagIcon,
  UserPlusIcon,
  UsersIcon,
  EraserIcon,
  LogOutIcon,
  MeshIcon,
  PinIcon,
  type MenuItem,
} from '../components/OverflowMenu';
import {AddressModal} from '../components/AddressModal';
import {AddressCard} from '../components/AddressCard';
import {LabelModal} from '../components/LabelModal';
import {MeshInfoModal} from '../components/MeshInfoModal';
import {InfoIcon} from '../components/InfoIcon';
import {InfoModal, InfoSection} from '../components/InfoModal';
import {BubbleActionMenu} from '../components/BubbleActionMenu';
import type {BubbleTarget} from '../components/BubbleActionMenu';
import {EmojiGridModal} from '../components/EmojiGridModal';
import {useComposerDraftStore} from '../stores/composerDraftStore';
import {ForwardPicker} from '../components/ForwardPicker';
import {MeshMapModal} from '../components/MeshMapModal';
import ImagePickerNative, {
  type PickedImage,
  type PickedRawMedia,
} from '../native/ImagePicker';
import {
  useChatStore,
  convoDisplayName,
  isAddressVerified,
  describePeer,
} from '../stores/chatStore';
import {formatLastSeen} from '../stores/conversationView';
import {meshPresence} from '../stores/meshPresence';
import type {Conversation, Message, SystemNote, MediaSend} from '../stores/chatStore';

// #313: send button "breathes" while the node is connecting.
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// #188: a timeline row is either a message or an interleaved system line.
type Row =
  | {kind: 'msg'; msg: Message}
  | {kind: 'sys'; sys: SystemNote}
  | {kind: 'media'; send: MediaSend}; // #308 in-flight video compress/upload
import LogosChat, {shortAddress} from '../native/LogosChat';
import {parseRelay} from '../native/relay';
import {parseImageLocal, isImageContent} from '../native/imageMsg';
import MediaShare from '../native/MediaShare';
import {parseVoiceLocal} from '../native/voiceMsg';
import {parseLocation, formatLatLng, geoUri, type LatLng} from '../native/locMsg';
import {VoiceBubble} from '../components/VoiceBubble';
import {CameraIcon, LocationIcon, MicIcon, PlayIcon, FilmIcon} from '../components/MediaIcons';
import AudioRecorder, {
  parseRecording,
  MAX_RECORDING_MS,
  subscribeRecordingAmplitude,
} from '../native/Audio';
import {deriveComposerState} from '../stores/groupState';
import {composerBudget} from '../mesh/composerBudget';
import {linkify} from '../text/linkify';
import {
  messageKey,
  isReactionContent,
  parseReaction,
  foldReactions,
  REACTION_PALETTE,
  type ReactionState,
} from '../messages/reactions';
import {isPinContent, parsePin, foldPins} from '../messages/pins';
import {isPfpContent, foldPfps} from '../messages/pfp';
import {isGroupCfgContent, foldGroupCfgs} from '../messages/groupcfg';
import {isFoldedMarker} from '../messages/markers';
import {isLeaveContent} from '../messages/leave';
import {encodeReply, parseReply, isReplyContent, displayBody} from '../messages/reply';
import {parseMedia, isMediaContent, mediaLabel} from '../messages/media';
import {isAddrContent, parseAddr, encodeAddr} from '../messages/address';
import {useMediaBlob} from '../native/mediaCache';
import {MediaVideo} from '../components/MediaVideo';
import {MediaViewer, type MediaAuthor} from '../components/MediaViewer';
import {
  enumerateMedia,
  mediaIndexOf,
  type MediaItem,
} from '../media/mediaList';
import {MediaSendBubble} from '../components/MediaSendBubble';
import Storage from '../native/Storage';
import {useNodeStore} from '../stores/nodeStore';
import {useMeshStore} from '../stores/meshStore';
import {useBleStore} from '../stores/bleStore';
import {useAvatarStore} from '../stores/avatarStore';
import type {RootStackParamList} from '../navigation/types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/** #199: an image bubble fits inside this box (aspect-preserved), so a tall
 * screenshot doesn't clog the thread. */
const IMG_MAX_W = 230;
const IMG_MAX_H = 300;

/** Fit (w×h) inside the IMG_MAX box preserving aspect ratio. */
function fitImage(w: number, h: number): {width: number; height: number} {
  const sw = w > 0 ? w : 1;
  const sh = h > 0 ? h : 1;
  const scale = Math.min(IMG_MAX_W / sw, IMG_MAX_H / sh, 1);
  return {width: Math.round(sw * scale), height: Math.round(sh * scale)};
}
// Mesh transport accent — theme has no green token (brand is orange), so the
// literal lives here per the mesh-transport design (docs/mesh-transport.md).
const MESH_GREEN = '#22C55E';
// #262: link color inside received bubbles (readable blue on the dark fill); own
// (orange) bubbles keep the white onAccent text, distinguished by the underline.
const LINK_BLUE = '#4EA3FF';

/** #295: a one-line preview of a message for a reply quote (media → friendly label). */
function quotePreview(text: string): string {
  const b = displayBody(text);
  if (parseImageLocal(b) != null) return 'Photo';
  if (parseVoiceLocal(b) != null) return 'Voice message';
  if (parseLocation(b) != null) return 'Location';
  return b;
}
// #261: how many images may be staged in the composer at once.
const MAX_STAGED_IMAGES = 10;
// #243: Bluetooth transport accent. A message that rode the BLE mesh (sentVia
// 'ble', Logos off/paused or peer nearby) is blue — own bubble filled blue, the
// send button blue — so "this went over Bluetooth" reads at a glance.
const BLE_BLUE = '#0EA5E9';

/** The attribution shown above an incoming bubble (#10). Display-only (#109). */
interface Attribution {
  label: string | null;
  hex: string;
  /** Full sender address — carried into the bubble's long-press menu. */
  address: string;
  /** #153: is this sender a locally-verified contact? */
  verified: boolean;
}

function formatTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

/**
 * Find the 1:1 conversation with `address`, if we already have one.
 * Case-insensitive: addresses come back from different layers in either case.
 */
function findDirectConvo(address: string): Conversation | undefined {
  const target = address.toLowerCase();
  return Object.values(useChatStore.getState().conversations).find(
    c => !c.isGroup && c.peerAddress?.toLowerCase() === target,
  );
}

// Resolve the sender line for an INCOMING message (#10). Own bubbles get none.
// 1:1 → the conversation's nickname; group → any 1:1 conversation whose
// peerAddress matches the directory-verified sender, else no label. The short
// hex falls back to the conversation peer when senderAccount is absent (1:1).
function resolveAttribution(
  msg: Message,
  isGroup: boolean,
  convo: Conversation | undefined,
): Attribution | null {
  if (msg.direction !== 'in') {
    return null;
  }
  const senderAddr = msg.senderAccount ?? convo?.peerAddress ?? null;
  if (senderAddr == null) {
    return null;
  }
  let label: string | null = null;
  if (isGroup) {
    if (msg.senderAccount != null) {
      const target = msg.senderAccount.toLowerCase();
      for (const c of Object.values(useChatStore.getState().conversations)) {
        if (
          !c.isGroup &&
          c.peerAddress != null &&
          c.peerAddress.toLowerCase() === target &&
          c.nickname != null &&
          c.nickname.length > 0
        ) {
          label = c.nickname;
          break;
        }
      }
    }
  } else {
    label = convo?.nickname != null && convo.nickname.length > 0 ? convo.nickname : null;
  }
  return {
    label,
    hex: shortAddress(senderAddr),
    address: senderAddr,
    verified: isAddressVerified(
      useChatStore.getState().conversations,
      senderAddr,
    ),
  };
}

// #257: a live moving waveform in the record area, shown while capturing a voice
// note. The native recorder now STREAMS the mic level to JS: it polls
// getMaxAmplitude() (~every 100 ms) and emits {eventType:"amplitude", level:0..1}
// on the "AudioRecorderEvent" channel (see AudioModule.kt + subscribeRecording-
// Amplitude). We scroll those real levels across the bars — a Booth-style
// equalizer that reacts to how loud you actually speak. If no amplitude arrives
// (older native build, or the stream stalls), we fall back to a synthetic
// oscillation so the bar still reads as "listening".
const REC_WAVE_BARS = 48;
// #257: if no real mic level lands within this window, drop back to the synthetic
// loop (and flip straight back to live the moment samples resume).
const REC_AMPLITUDE_FALLBACK_MS = 500;
// #257: floor so a quiet room still shows a visible stub; map level 0..1 onto
// scaleY [floor..1]. getMaxAmplitude peaks are small for speech, so lift with a
// mild curve (sqrt) to make normal talking fill the bar rather than hug the floor.
const REC_WAVE_FLOOR = 0.12;
// #257: max bar height (px) inside the 24px record row — the waveform grows
// symmetrically from the centre line (recWave alignItems:center).
const REC_WAVE_HEIGHT = 26;
// #257: Booth-style live waveform in the composer — a rolling buffer of the recent
// mic levels (newest on the right, flowing left as you speak), each bar coloured by
// loudness (green → amber → orange). Driven by the REAL amplitude stream (~10 Hz);
// if none arrives (older native build / stalled), a gentle synthetic scroll keeps
// it alive so the row still reads as "listening".
function RecordingWaveform() {
  const [levels, setLevels] = useState<number[]>(() =>
    new Array(REC_WAVE_BARS).fill(REC_WAVE_FLOOR),
  );
  const buf = React.useRef<number[]>(new Array(REC_WAVE_BARS).fill(REC_WAVE_FLOOR));
  const liveRef = React.useRef(false);

  useEffect(() => {
    const push = (level: number) => {
      const clamped = Math.max(0, Math.min(1, level));
      // sqrt lifts quiet speech off the floor so normal talking fills the bar.
      const h = REC_WAVE_FLOOR + Math.sqrt(clamped) * (1 - REC_WAVE_FLOOR);
      const b = buf.current;
      b.shift();
      b.push(h);
      setLevels(b.slice());
    };
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribeRecordingAmplitude(level => {
      liveRef.current = true;
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        liveRef.current = false;
      }, REC_AMPLITUDE_FALLBACK_MS);
      push(level);
    });
    // Synthetic scroll — runs ONLY while no real levels are streaming.
    const synth = setInterval(() => {
      if (!liveRef.current) push(0.25 + Math.random() * 0.5);
    }, 70);
    return () => {
      unsub();
      clearInterval(synth);
      if (watchdog) clearTimeout(watchdog);
    };
  }, []);

  return (
    <View style={styles.recWave} testID="rec-waveform" pointerEvents="none">
      {levels.map((lv, i) => (
        <View
          key={i}
          style={[
            styles.recWaveBar,
            {
              height: Math.max(3, Math.round(lv * REC_WAVE_HEIGHT)),
              backgroundColor:
                lv < 0.4 ? '#22C55E' : lv < 0.7 ? '#EAB308' : '#FF7A33',
            },
          ]}
        />
      ))}
    </View>
  );
}

function Bubble({
  msg,
  attribution,
  avatarKind,
  onRetry,
  onLongPress,
  onOpenMedia,
  onOpenLocation,
  reactions,
  onReact,
  onShowReactors,
  quoted,
  replyText,
  onQuotedPress,
  storageOff,
}: {
  msg: Message;
  attribution: Attribution | null;
  // #251: the sender identicon's color follows the conversation's transport
  // (mesh green / BLE blue / Logos orange), not a hardcoded contact orange.
  avatarKind: AvatarKind;
  // #344: this group has storage off (text-only) → media bubbles render a
  // placeholder and never fetch from Storage; the sender identicon skips its avatar.
  storageOff?: boolean;
  onRetry: () => void;
  onLongPress: (pageY: number) => void;
  // #479: open the unified media viewer at this message; it builds the ordered
  // media list from the conversation and pages across photos/gifs/videos.
  onOpenMedia?: (msgPk: number) => void;
  onOpenLocation: (loc: {lat: number; lng: number}) => void;
  // #264: folded reaction aggregates for this message + a toggle callback.
  reactions?: ReactionState[];
  onReact?: (emoji: string, mine: boolean) => void;
  // #293: long-press a pill to see who reacted with that emoji.
  onShowReactors?: (r: ReactionState) => void;
  // #295: a quoted-reply header ({author label, snippet}) drawn atop the bubble.
  quoted?: {author: string; snippet: string} | null;
  // #295: for a reply, the body text to render (the marker's payload).
  replyText?: string;
  // #295: tap the quoted header to jump to the original message.
  onQuotedPress?: () => void;
}) {
  const own = msg.direction === 'out';
  const failed = msg.status === 'failed';
  // #167: a message that rode the MeshCore radio (not MLS) is badged — subtle
  // green edge + a "via mesh" caption, so it reads as "over the mesh, not MLS".
  // #168: 'both' = delivered on Logos AND mesh (deduped) — still badge it as mesh-touched.
  const viaMesh = msg.sentVia === 'mesh' || msg.sentVia === 'both';
  const viaLabel = msg.sentVia === 'both' ? 'via mesh + logos · ' : 'via mesh · ';
  // #243: a message carried over the BLE mesh — blue, mirroring the mesh badge.
  const viaBle = msg.sentVia === 'ble';
  // #168: a bridged (relayed) message carries an envelope naming its ORIGINAL
  // sender — B (the relayer) signed/sent it, so its raw attribution is B. Unwrap
  // it: show the real origin + the real text, marked "via <bridge>" and NOT
  // verified (a relay is a local assertion, not per-message crypto).
  // #190: name the relayer instead of the anonymous "via bridge". The carrying
  // message's sender IS the bridge, so the PRE-override `attribution` (built from
  // msg.senderAccount for a Logos-arrived relay) describes them — reuse its
  // label ?? hex. MessageRow carries no mesh sender-name, so a mesh-arrived relay
  // (attribution == null) falls back to a plain 'bridge'.
  // #295: a reply stores its body inside a `reply1:` marker — render from the body,
  // not the raw marker (the quoted header is drawn separately from `quoted`).
  const raw = replyText ?? msg.text;
  // Media messages store a compact local marker; render each kind specially.
  const image = parseImageLocal(raw); // #197
  const voice = parseVoiceLocal(raw); // #205
  const location = parseLocation(raw); // #204
  const imgDims = image != null ? fitImage(image.meta.width, image.meta.height) : null;
  // #300: store1: media hosted on Logos Storage — fetched+decrypted on demand.
  const mediaRef = isMediaContent(raw) ? parseMedia(raw) : null;
  // #344: in a storage-off group, a media message renders a placeholder and MUST
  // NOT fetch — pass null to useMediaBlob so no Storage request ever fires.
  const mediaBlocked = storageOff === true && mediaRef != null;
  const media = useMediaBlob(mediaBlocked ? null : mediaRef);
  const mediaDims = mediaRef != null ? fitImage(mediaRef.width, mediaRef.height) : null;
  const relay = parseRelay(raw);
  const displayText = relay?.text ?? raw;
  const bridgeName =
    attribution != null ? attribution.label ?? attribution.hex : 'bridge';
  const effAttr =
    relay != null
      ? {
          label: relay.origin,
          hex: `· via ${bridgeName}`,
          address: relay.origin,
          verified: false,
        }
      : attribution;
  return (
    <View style={[styles.bubbleWrap, own ? styles.wrapOwn : styles.wrapPeer]}>
      {/* Display only (#109): the contact actions live on the bubble long-press.
          A tiny identicon (#118) makes senders distinct in a busy group thread. */}
      {effAttr != null && (
        <View style={styles.attrRow} testID={`attr-${effAttr.address}`}>
          <HexAvatar seed={effAttr.address} kind={avatarKind} size={16} disableImage={storageOff} />
          {/* #122: primary line white; the hex is the gray secondary when a
              label exists, and the white primary itself when there's no label. */}
          {effAttr.label != null ? (
            <Text style={styles.attrLine} numberOfLines={1}>
              <Text style={{color: colors.text}}>{effAttr.label}</Text>
              <Text style={{color: colors.textDim}}> {effAttr.hex}</Text>
            </Text>
          ) : (
            <Text
              style={[styles.attrLine, {color: colors.text}]}
              numberOfLines={1}>
              {effAttr.hex}
            </Text>
          )}
          {effAttr.verified && <VerifiedBadge size={12} />}
        </View>
      )}
      {/* #299: bubble + its corner reactions share a relative box. */}
      <View style={styles.bubbleBox}>
      {/* Short tap = retry (failed only); long press = the action menu. The
          Pressable must stay ENABLED or `disabled` would kill onLongPress too. */}
      <Pressable
        onPress={
          failed
            ? onRetry
            : image != null
            ? () => onOpenMedia?.(msg.msgPk)
            : mediaRef != null && media.status === 'ready'
            ? () => onOpenMedia?.(msg.msgPk)
            : location != null
            ? () => onOpenLocation(location)
            : undefined
        }
        onLongPress={e => onLongPress(e.nativeEvent.pageY)}
        delayLongPress={350}
        testID={`bubble-${msg.msgPk}`}
        style={[
          styles.bubble,
          own ? styles.bubbleOwn : styles.bubblePeer,
          msg.status === 'pending' && styles.bubblePending,
          viaMesh && (own ? styles.bubbleMeshOwn : styles.bubbleMeshPeer),
          viaBle && (own ? styles.bubbleBleOwn : styles.bubbleBlePeer),
          failed && styles.bubbleFailed,
          (image != null || mediaRef != null) && styles.bubbleImage, // #300 thin 2px frame
        ]}>
        {/* #295: quoted-reply header — tap to jump to the original. */}
        {quoted != null && (
          <Pressable
            onPress={onQuotedPress}
            style={[styles.quoteBlock, {borderLeftColor: own ? colors.onAccent : colors.accent}]}
            testID="quote-block">
            <Text
              style={[styles.quoteAuthor, {color: own ? colors.onAccent : colors.accent}]}
              numberOfLines={1}>
              {quoted.author}
            </Text>
            <Text
              style={[styles.quoteSnippet, {color: own ? colors.onAccent : colors.textDim}]}
              numberOfLines={1}>
              {quoted.snippet}
            </Text>
          </Pressable>
        )}
        {mediaBlocked && mediaDims != null ? (
          // #344: storage-off group — never fetch/show the blob. Show a placeholder
          // sized to the bubble so the timeline doesn't jump.
          <View
            style={[
              styles.mediaBox,
              {width: mediaDims.width, height: mediaDims.height},
            ]}
            testID="media-disabled">
            <Text
              style={[type.caption, {color: own ? colors.onAccent : colors.textDim, textAlign: 'center', paddingHorizontal: spacing.md}]}>
              media disabled in this group
            </Text>
          </View>
        ) : mediaRef != null && mediaDims != null ? (
          // #300: Logos-Storage media. Ready → GIFs animate in <Image> (Fresco
          // animated-gif); videos play muted+looping in <MediaVideo>. Loading/error keep
          // the bubble sized so the timeline doesn't jump.
          media.status === 'ready' ? (
            mediaRef.mime.startsWith('video/') ? (
              // Videos don't autoplay inline: show the first frame (paused) with a play
              // overlay; tapping the bubble opens the fullscreen player (with controls).
              <View style={{width: mediaDims.width, height: mediaDims.height}}>
                <MediaVideo
                  path={media.path}
                  paused
                  style={{width: mediaDims.width, height: mediaDims.height, borderRadius: radii.card - 2}}
                />
                <View style={styles.playOverlay} pointerEvents="none">
                  <View style={styles.playBadge}>
                    <PlayIcon size={28} color="#fff" />
                  </View>
                </View>
              </View>
            ) : (
              <Image
                source={{uri: `file://${media.path}`}}
                style={{width: mediaDims.width, height: mediaDims.height, borderRadius: radii.card - 2}}
                resizeMode="cover"
              />
            )
          ) : (
            <View
              style={[
                styles.mediaBox,
                {width: mediaDims.width, height: mediaDims.height},
              ]}>
              {media.status === 'loading' ? (
                <ActivityIndicator color={own ? colors.onAccent : colors.textDim} />
              ) : (
                <Text style={[type.caption, {color: own ? colors.onAccent : colors.textDim}]}>
                  {/* #303: a blob evicted by node retention 404s → honest "expired", not a
                      generic failure. */}
                  {media.status === 'expired'
                    ? 'media expired'
                    : media.status === 'error'
                    ? 'media unavailable'
                    : mediaLabel(raw)}
                </Text>
              )}
            </View>
          )
        ) : image != null && imgDims != null ? (
          <Image
            source={{uri: `file://${image.path}`}}
            style={{
              width: imgDims.width,
              height: imgDims.height,
              borderRadius: radii.card - 2,
            }}
            resizeMode="cover"
          />
        ) : voice != null ? (
          <VoiceBubble
            path={voice.path}
            meta={voice.meta}
            tint={own ? colors.onAccent : colors.text}
          />
        ) : location != null ? (
          <View style={styles.locRow}>
            <Text style={[type.body, {color: own ? colors.onAccent : colors.text}]}>
              📍 {formatLatLng(location)}
            </Text>
            <Text
              style={[
                type.caption,
                {color: own ? colors.onAccent : colors.textDim, opacity: 0.8},
              ]}>
              Tap to open in maps
            </Text>
          </View>
        ) : (
          <Text style={[type.body, {color: own ? colors.onAccent : colors.text}]}>
            {/* #262: split into plain + tappable link runs. Links are underlined
                and open on tap; own-bubble links stay white, peer links go blue. */}
            {linkify(displayText).map((run, i) =>
              run.url != null ? (
                <Text
                  key={i}
                  style={[styles.link, {color: own ? colors.onAccent : LINK_BLUE}]}
                  onPress={() => Linking.openURL(run.url!).catch(() => {})}
                  testID="msg-link">
                  {run.text}
                </Text>
              ) : (
                run.text
              ),
            )}
          </Text>
        )}
      </Pressable>
      {/* #264/#299: reaction pills at the bubble's lower corner (own=right, peer=left),
          overlapping the edge — tap yours to remove, tap another to add. */}
      {reactions != null && reactions.length > 0 && (
        <View style={[styles.reactStrip, own ? styles.reactStripOwn : styles.reactStripPeer]}>
          {reactions.map(r => (
            <Pressable
              key={r.emoji}
              onPress={() => onReact?.(r.emoji, r.mine)}
              onLongPress={() => onShowReactors?.(r)}
              style={[styles.reactPill, r.mine && styles.reactPillMine]}
              testID={`react-${r.emoji}`}>
              <Text style={styles.reactEmoji}>{r.emoji}</Text>
              {r.count > 1 && <Text style={styles.reactCount}>{r.count}</Text>}
            </Pressable>
          ))}
        </View>
      )}
      </View>{/* #299 end bubbleBox */}
      <View
        style={[
          styles.timeRow,
          reactions != null && reactions.length > 0 && styles.timeRowReacted,
        ]}>
        {viaMesh && <Text style={styles.viaMesh}>{viaLabel}</Text>}
        {viaBle && <Text style={styles.viaBle}>via BLE · </Text>}
        <Text style={[styles.time, failed && {color: colors.unread}]}>
          {msg.status === 'pending'
            ? 'sending…'
            : failed
            ? 'failed — tap to retry'
            : formatTime(msg.at)}
        </Text>
      </View>
    </View>
  );
}

export function ChatScreen() {
  const route = useRoute<RouteProp<RootStackParamList, 'Chat'>>();
  const navigation = useNavigation<Nav>();
  const {convoPk} = route.params;
  const convo = useChatStore(s => s.conversations[convoPk]);
  const messages = useChatStore(s => s.messages[convoPk]) ?? [];
  const groupMembers = useChatStore(s => s.members[convoPk]);
  // #444 (review of PR #447): the header subtitle depends on the roster SIZE, and
  // the header is registered through navigation.setOptions — a closure that only
  // re-registers when the effect re-runs. loadMembers() replaces the roster array
  // wholesale, so depending on `groupMembers` itself would re-register the header
  // on every reload; the count is the stable value the header actually reads.
  const groupMemberCount = groupMembers?.length ?? 0;
  // #174: all rosters — used to resolve whether the 1:1 peer is mesh-mapped.
  const allMembers = useChatStore(s => s.members);
  const loadMembers = useChatStore(s => s.loadMembers);
  const switchGroupToMesh = useChatStore(s => s.switchGroupToMesh);
  const switchGroupToLogos = useChatStore(s => s.switchGroupToLogos);
  const meshStatus = useMeshStore(s => s.status);
  const meshContacts = useMeshStore(s => s.contacts); // #212 presence roster
  const hydrateMeshContacts = useMeshStore(s => s.hydrateContacts);
  const meshMapCache = useChatStore(s => s.meshMap); // #210
  const loadMessages = useChatStore(s => s.loadMessages);
  const loadMoreMessages = useChatStore(s => s.loadMoreMessages);
  const loadingMore = useChatStore(s => s.loadingMore[convoPk]) ?? false;
  const addMember = useChatStore(s => s.addMember);
  const requestReadd = useChatStore(s => s.requestReadd);
  const send = useChatStore(s => s.send);
  const sendReaction = useChatStore(s => s.sendReaction); // #264
  const pinMessage = useChatStore(s => s.pinMessage); // #266
  const sendImage = useChatStore(s => s.sendImage);
  const sendGif = useChatStore(s => s.sendGif); // #306 gif via Logos Storage
  const stageVideo = useChatStore(s => s.stageVideo); // #307 pick+stage a video
  const sendStagedVideo = useChatStore(s => s.sendStagedVideo); // #305/#308 compress→upload→send
  const stageImages = useChatStore(s => s.stageImages); // #261
  const stageCameraPhoto = useChatStore(s => s.stageCameraPhoto); // #261
  const sendStagedImages = useChatStore(s => s.sendStagedImages); // #261
  const fetchLocation = useChatStore(s => s.fetchLocation); // #255
  const sendLocationValue = useChatStore(s => s.sendLocationValue); // #255
  const sendVoice = useChatStore(s => s.sendVoice); // #205
  const retry = useChatStore(s => s.retry);
  const setActive = useChatStore(s => s.setActive);
  const setNickname = useChatStore(s => s.setNickname);
  const setVerified = useChatStore(s => s.setVerified);
  const wipe = useChatStore(s => s.wipe);
  const leaveGroup = useChatStore(s => s.leaveGroup);
  const setMemberStatus = useChatStore(s => s.setMemberStatus); // #283 leave lines
  const remove = useChatStore(s => s.remove);
  const deleteMessage = useChatStore(s => s.deleteMessage); // #263
  const startConversation = useChatStore(s => s.startConversation);
  const probeGroup = useChatStore(s => s.probeGroup);
  const hydrateSystemLines = useChatStore(s => s.hydrateSystemLines);
  const recreateGroup = useChatStore(s => s.recreateGroup);
  const liveness = useChatStore(s => s.liveness[convoPk]);
  const systemLines = useChatStore(s => s.systemLines[convoPk]);
  // #344: per-group storage opt-out — text-only when true.
  const storageOff = useChatStore(s => s.storageOff[convoPk] ?? false);
  const hydrateGroupStorage = useChatStore(s => s.hydrateGroupStorage);
  const nodeStatus = useNodeStore(s => s.status);
  const nodeError = useNodeStore(s => s.error);
  const clearError = useNodeStore(s => s.clearError);
  const myAddress = useNodeStore(s => s.myAddress); // #264 reaction author/reactor
  // #237: a 1:1 whose peer is heard on the BLE mesh right now can be messaged even
  // when Logos is off (MLS encrypts locally; BLE carries the ciphertext).
  const bleStatus = useBleStore(s => s.status);
  const bleNearby = useBleStore(s => s.nearbyContacts);
  const bleReachable =
    convo?.peerAddress != null &&
    bleStatus === 'on' &&
    bleNearby.some(a => a.toLowerCase() === convo.peerAddress!.toLowerCase());
  // #296: hydrate the composer from this conversation's saved draft (survives leaving
  // and returning to the chat). A #113 prefill (route.params.draft) still wins when set.
  const initialDraft = useComposerDraftStore.getState().getDraft(convoPk);
  // #113: a prefilled draft (e.g. "Ping creator" seeds a re-create request).
  const [text, setText] = useState(route.params.draft ?? initialDraft?.text ?? '');
  // #255: a location fix staged in the composer, previewed before the user sends.
  const [pendingLoc, setPendingLoc] = useState<LatLng | null>(
    initialDraft?.pendingLoc ?? null,
  );
  // #261: images picked/captured but not yet sent — previewed as removable
  // thumbnails above the composer, dispatched on Send (like the location chip).
  const [pendingImages, setPendingImages] = useState<PickedImage[]>(
    initialDraft?.pendingImages ?? [],
  );
  // #423: HQ photos (high quality via Storage) vs standard inline. HQ needs
  // Storage, so it's unavailable — and forced off — in a storage-off group.
  const [hqPhotos, setHqPhotos] = useState(false);
  const hqActive = hqPhotos && !storageOff;
  // #307: a single video staged in the composer (poster thumbnail + play badge), sent on Send.
  const [pendingVideo, setPendingVideo] = useState<PickedRawMedia | null>(null);
  // #308: in-flight video sends for this convo (compress→upload), rendered as progress bubbles.
  const mediaSends = useChatStore(s => s.mediaSends);
  const convoMediaSends = useMemo(
    () => Object.values(mediaSends).filter(m => m.convoPk === convoPk),
    [mediaSends, convoPk],
  );
  const [busy, setBusy] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [recording, setRecording] = useState(false); // #205 voice
  const [recElapsed, setRecElapsed] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  // #124/#330: the address shown in the AddressModal — the thread peer (header
  // "Show address") OR a shared-contact card's address ("View").
  const [addressTarget, setAddressTarget] = useState<{
    address: string | null;
    label: string | null;
    verified: boolean;
  } | null>(null);
  // The contact the label editor is for: the thread peer (header menu) OR the
  // sender of a long-pressed bubble (works for group members too).
  const [labelTarget, setLabelTarget] = useState<{
    address: string | null;
    label: string | null;
    verified: boolean;
  } | null>(null);
  const [bubbleTarget, setBubbleTarget] = useState<BubbleTarget | null>(null);
  // #295: the message being replied to (composer shows a quote banner; send wraps
  // the typed text in a reply1: marker pointing at this key). Null = normal send.
  const [replyDraft, setReplyDraft] = useState<{
    key: string;
    author: string;
    snippet: string;
  } | null>(initialDraft?.replyDraft ?? null);
  // #296: persist the composer draft per conversation on every change, so navigating
  // away and back restores it. The store drops empty drafts, so a successful send (which
  // clears all of these) also clears the saved draft.
  useEffect(() => {
    useComposerDraftStore
      .getState()
      .setDraft(convoPk, {text, pendingLoc, pendingImages, replyDraft});
  }, [convoPk, text, pendingLoc, pendingImages, replyDraft]);
  const listRef = React.useRef<FlatList<Row>>(null); // #266: scroll to the pinned msg
  const rowsRef = React.useRef<Row[]>([]); // #295: latest rows for reply scroll-to
  const [bubbleY, setBubbleY] = useState(0); // #157: anchor the bubble menu near the tap
  const [forwardContent, setForwardContent] = useState<string | null>(null); // #201
  const [emojiPickerTarget, setEmojiPickerTarget] = useState<BubbleTarget | null>(null); // #298
  // #479: one full-screen media viewer for photos/gifs/videos, opened at a tapped
  // message and paging across all the conversation's media.
  const [viewer, setViewer] = useState<{items: MediaItem[]; index: number} | null>(
    null,
  );
  const forwardMessage = useChatStore(s => s.forwardMessage);
  // #210: map-to-mesh from the bubble menu (local, works offline).
  const [mapTarget, setMapTarget] = useState<{address: string; label: string | null} | null>(null);
  const mapMeshIdentity = useChatStore(s => s.mapMeshIdentity);
  const unmapMeshIdentity = useChatStore(s => s.unmapMeshIdentity);
  // #210: resolve the current mesh mapping for an address — the roster covers
  // group members, and the explicit meshMap cache covers 1:1 peers (whose
  // groupMembers roster is empty) so the menu label + modal pre-fill stay honest.
  const meshMemberPubkey = (address: string): string | null => {
    const key = address.toLowerCase();
    const fromRoster = (groupMembers ?? []).find(
      m => m.address.toLowerCase() === key,
    )?.meshPubkey;
    if (fromRoster != null) return fromRoster;
    return meshMapCache[key]?.pubkey ?? null;
  };
  // #112: set after a successful re-create so the thread can report what happened.
  const [reviving, setReviving] = useState(false);
  // #168: the "About mesh mirroring" explainer (banner (i) + ⋮ menu).
  const [meshInfoOpen, setMeshInfoOpen] = useState(false);
  // #191/#192: explainer modals for the restart-group action and the invited wait.
  const [restartInfoOpen, setRestartInfoOpen] = useState(false);
  const [invitedInfoOpen, setInvitedInfoOpen] = useState(false);

  useFocusEffect(
    useCallback(() => {
      setActive(convoPk);
      loadMessages(convoPk);
      // #228: load persisted invited/joined system notes so they survive restart.
      hydrateSystemLines(convoPk).catch(() => {});
      // #344: load the persisted storage-off flag so text-only mode survives restart.
      hydrateGroupStorage(convoPk).catch(() => {});
      // #112: a group from an earlier node session cannot be operated (#103).
      // Probe once on focus so the thread can say so instead of failing on send.
      // #167: a MeshCore channel is is_group=true but NOT a Logos MLS group — the
      // Logos liveness probe would wrongly flag it dead, so skip it for mesh.
      const c = useChatStore.getState().conversations[convoPk];
      if (c?.transport !== 'mesh' && (route.params.isGroup === true || c?.isGroup)) {
        probeGroup(convoPk).catch(() => {});
      }
      // #168: a Logos group needs its roster to compute "N/M mapped to mesh".
      if (c?.transport !== 'mesh' && (route.params.isGroup === true || c?.isGroup)) {
        loadMembers(convoPk).catch(() => {});
      }
      return () => setActive(null);
    }, [convoPk, setActive, loadMessages, hydrateSystemLines, hydrateGroupStorage, probeGroup, loadMembers, route.params.isGroup]),
  );

  const isGroup = convo?.isGroup ?? route.params.isGroup ?? false;

  // #479: open the full-screen viewer at a tapped media message. Build the ordered
  // media list from the live store (not the render `messages` closure) so a tap
  // always pages across every photo/gif/video currently in the thread.
  // #344: in a storage-off group stored media is excluded — otherwise tapping an
  // allowed inline photo (#422) would page historical store*: blobs into view and
  // fetch+decrypt them, bypassing the bubble guard. Read storageOff live from the
  // store for the same reason the rows are read there: no stale render closure.
  const openMediaViewer = useCallback(
    (msgPk: number) => {
      const st = useChatStore.getState();
      const items = enumerateMedia(st.messages[convoPk] ?? [], {
        storageOff: st.storageOff[convoPk] ?? false,
      });
      const idx = mediaIndexOf(items, msgPk);
      if (idx >= 0) setViewer({items, index: idx});
    },
    [convoPk],
  );
  // Author block for the viewer's bar — mirrors the in-bubble sender line. Own
  // (outgoing) media has no author block.
  const mediaAuthorFor = useCallback(
    (item: MediaItem): MediaAuthor | null => {
      const m = (useChatStore.getState().messages[convoPk] ?? []).find(
        r => r.msgPk === item.msgPk,
      );
      if (m == null) return null;
      const attr = resolveAttribution(m, isGroup, convo);
      if (attr == null) return null;
      const kind: AvatarKind = convo
        ? convoKind({transport: convo.transport, isGroup})
        : 'contact';
      return {address: attr.address, label: attr.label, hex: attr.hex, kind};
    },
    [convoPk, isGroup, convo],
  );
  // #483: the download silently no-op'd — the promise error was swallowed and
  // there was no success feedback. Await it, confirm with a toast, surface errors.
  const saveMediaFromViewer = useCallback(
    async (item: MediaItem, path: string) => {
      try {
        if (isImageContent(item.content)) {
          await ImagePickerNative.saveImageToGallery(path);
        } else {
          const ref = parseMedia(item.content);
          if (ref == null) return;
          await ImagePickerNative.saveMediaToGallery(path, ref.mime);
        }
        useNodeStore.setState({error: 'saved to gallery'});
        // auto-clear the success note so it doesn't linger like a stuck error.
        setTimeout(() => {
          if (useNodeStore.getState().error === 'saved to gallery') {
            useNodeStore.setState({error: null});
          }
        }, 2500);
      } catch (e: any) {
        useNodeStore.setState({error: `save failed: ${e?.message ?? e}`});
      }
    },
    [],
  );
  const shareMediaFromViewer = useCallback((item: MediaItem, path: string) => {
    const mime = isImageContent(item.content)
      ? parseImageLocal(item.content)?.meta.mime ?? 'image/*'
      : parseMedia(item.content)?.mime ?? '*/*';
    MediaShare.shareFile(path, mime).catch((e: any) =>
      useNodeStore.setState({error: `share failed: ${e?.message ?? e}`}),
    );
  }, []);
  // #479: the media viewer is an in-tree overlay (not a Modal — a Modal teardown
  // ANR'd on unmount). An overlay can't paint over the NATIVE header, so hide it
  // while the viewer is open; restore it on close.
  useEffect(() => {
    // (options built separately so this simple visibility toggle isn't mistaken
    // for the header-closure effect below — see chatHeaderDeps.test.ts)
    const opts = {headerShown: viewer == null};
    navigation.setOptions(opts);
  }, [navigation, viewer]);
  // #167: a MeshCore channel (transport='mesh') sends over the radio, not the node.
  const isMesh = convo?.transport === 'mesh';

  // #174: is the 1:1 peer mapped to a MeshCore identity? The mapping is harvested
  // from group rosters (the mesh_map JOIN surfaced on GroupMember) — scan every
  // roster for this peer's address, same source the contact/list surfaces use.
  const peerMesh = useMemo(() => {
    if (isGroup || convo?.peerAddress == null) {
      return null;
    }
    const target = convo.peerAddress.toLowerCase();
    // #210: an explicit mesh_map (set from Contacts / a 1:1) wins + covers peers
    // never seen in a group roster.
    const mapped = meshMapCache[target];
    if (mapped != null) return {pubkey: mapped.pubkey, name: mapped.name};
    for (const roster of Object.values(allMembers)) {
      for (const m of roster) {
        if (!m.isSelf && m.meshPubkey != null && m.address.toLowerCase() === target) {
          return {pubkey: m.meshPubkey, name: m.meshName ?? null};
        }
      }
    }
    return null;
  }, [isGroup, convo?.peerAddress, allMembers, meshMapCache]);

  // #212: honest mesh presence for this peer — "heard Xm ago" (green when live).
  const peerPresence = useMemo(
    () =>
      meshPresence(peerMesh?.pubkey, meshContacts, meshStatus === 'connected', Date.now()),
    [peerMesh, meshContacts, meshStatus],
  );

  // Load the persisted mesh roster (with last-heard) so presence shows even offline.
  useEffect(() => {
    hydrateMeshContacts();
  }, [hydrateMeshContacts]);

  const onTrash = useCallback(() => {
    Alert.alert('Delete conversation', 'Delete this conversation and all its messages?', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          remove(convoPk)
            .then(() => navigation.goBack())
            .catch(e => useNodeStore.setState({error: `delete failed: ${e?.message ?? e}`}));
        },
      },
    ]);
  }, [remove, convoPk, navigation]);

  // Wipe = local content only. Say so plainly: it does NOT leave the group, and
  // messages sent after the wipe still arrive (#107).
  const onWipe = useCallback(() => {
    Alert.alert(
      'Wipe group',
      'Wipe this group from this device? All its messages will be deleted here. ' +
        'You will still receive new messages — wiping does not remove you from the group.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Wipe',
          style: 'destructive',
          onPress: () => {
            wipe(convoPk).catch(e =>
              useNodeStore.setState({error: `wipe failed: ${e?.message ?? e}`}),
            );
          },
        },
      ],
    );
  }, [wipe, convoPk]);

  // Leave = ask the group to remove us AND drop the thread locally (#108).
  // Deliberately honest: removal is a consensus round, so it is *submitted*, not
  // instant — and it cannot work at all for a group from an earlier session
  // (#103), which is why the failure path keeps the thread instead of pretending.
  const onLeave = useCallback(() => {
    Alert.alert(
      'Leave group',
      "Leave this group? Its messages are deleted from this device and it's " +
        'hidden for good. The other members are told you left. You cannot rejoin ' +
        'unless someone re-invites you into a new group.',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Leave',
          style: 'destructive',
          onPress: () => {
            leaveGroup(convoPk)
              .then(() => {
                ToastAndroid.show('Leaving the group…', ToastAndroid.SHORT);
                navigation.goBack();
              })
              .catch(e =>
                useNodeStore.setState({
                  error: `could not leave: ${e?.message ?? e}`,
                }),
              );
          },
        },
      ],
    );
  }, [leaveGroup, convoPk, navigation]);

  const openLabel = useCallback(
    () =>
      setLabelTarget({
        address: convo?.peerAddress ?? null,
        label: convo?.nickname ?? null,
        verified: convo?.verified ?? false,
      }),
    [convo],
  );

  /**
   * Persist a label for an arbitrary address: reuse the 1:1 conversation with
   * that peer if we have one, otherwise create the contact so a group member
   * can be named straight from their bubble.
   */
  const saveLabelFor = useCallback(
    async (address: string | null, newLabel: string, verified: boolean) => {
      if (address == null) {
        return;
      }
      const existing = findDirectConvo(address);
      try {
        let pk: number;
        if (existing != null) {
          pk = existing.convoPk;
          await setNickname(pk, newLabel);
        } else {
          pk = await startConversation(address, {nickname: newLabel || undefined});
        }
        await setVerified(pk, verified);
      } catch (e: any) {
        useNodeStore.setState({error: `label failed: ${e?.message ?? e}`});
      }
    },
    [setNickname, startConversation, setVerified],
  );

  /** "Send message" on a group member's bubble (#109): resolve-or-create the 1:1. */
  const openDirectWith = useCallback(
    async (address: string, draft?: string) => {
      try {
        const existing = findDirectConvo(address);
        const pk =
          existing != null ? existing.convoPk : await startConversation(address);
        const target = useChatStore.getState().conversations[pk];
        navigation.navigate('Chat', {
          convoPk: pk,
          convoName:
            target != null ? convoDisplayName(target) : shortAddress(address),
          isGroup: false,
          draft, // #113: prefill (e.g. a "please re-create the group" ping)
        });
      } catch (e: any) {
        useNodeStore.setState({error: `could not open chat: ${e?.message ?? e}`});
      }
    },
    [startConversation, navigation],
  );

  // #330: "Add contact" on a shared-address card — reuse-or-create the 1:1 with
  // this address (carrying the shared label as the local nickname) and open it.
  const onAddSharedContact = useCallback(
    async (address: string, label?: string) => {
      try {
        const existing = findDirectConvo(address);
        const pk =
          existing != null
            ? existing.convoPk
            : await startConversation(address, {nickname: label});
        const target = useChatStore.getState().conversations[pk];
        navigation.navigate('Chat', {
          convoPk: pk,
          convoName:
            target != null ? convoDisplayName(target) : shortAddress(address),
          isGroup: false,
        });
      } catch (e: any) {
        useNodeStore.setState({error: `could not add contact: ${e?.message ?? e}`});
      }
    },
    [startConversation, navigation],
  );

  const hasLabel = convo?.nickname != null && convo.nickname.length > 0;

  // One menu for the whole thread (#104 1:1, #107 groups).
  const menuItems: MenuItem[] = isGroup
    ? [
        {
          key: 'add-members',
          label: 'Add members',
          icon: <UserPlusIcon color={colors.textDim} />,
          onPress: () => navigation.navigate('AddMembers', {convoPk}),
        },
        {
          key: 'group-info',
          label: 'Group info',
          icon: <UsersIcon color={colors.textDim} />,
          onPress: () => navigation.navigate('GroupInfo', {convoPk}),
        },
        {
          key: 'wipe-group',
          label: 'Wipe group',
          icon: <EraserIcon color={colors.unread} />,
          onPress: onWipe,
          destructive: true,
        },
        {
          key: 'leave-group',
          label: 'Leave group',
          icon: <LogOutIcon color={colors.unread} />,
          onPress: onLeave,
          destructive: true,
        },
      ]
    : [
        {
          key: 'label',
          label: hasLabel ? 'Edit label' : 'Add label',
          icon: <TagIcon color={colors.textDim} />,
          onPress: openLabel,
        },
        {
          key: 'show-address',
          label: 'Show address',
          icon: <QrIcon size={20} color={colors.textDim} />,
          onPress: () =>
            setAddressTarget({
              address: convo?.peerAddress ?? null,
              label: convo?.nickname ?? null,
              verified: convo?.verified ?? false,
            }),
        },
        {
          key: 'delete',
          label: 'Delete conversation',
          icon: <TrashIcon size={20} color={colors.unread} />,
          onPress: onTrash,
          destructive: true,
        },
      ];

  useEffect(() => {
    // #123: fold the back arrow + avatar + title into ONE left cluster via
    // headerLeft, so the identity block truly hugs the arrow (native-stack leaves
    // a fixed gap between the back button and headerTitle otherwise). headerTitle
    // is emptied and the native back button hidden.
    const back = (
      <Pressable
        onPress={() => navigation.goBack()}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={styles.headerBackBtn}
        testID="chat-back">
        <BackIcon color={colors.text} />
      </Pressable>
    );
    navigation.setOptions({
      headerBackVisible: false,
      headerLeft: () => {
        if (convo == null) {
          return <View style={styles.headerLeftCluster}>{back}</View>;
        }
        // Leading identicon matches the conversation list (#118): a group is
        // seeded by its shared lib id (azure), a 1:1 by the peer address (orange).
        const avatar = (
          <HexAvatar seed={avatarSeed(convo)} kind={convoKind(convo)} size={28} disableImage={storageOff} locked={isGroup && storageOff} />
        );
        if (isGroup) {
          // #444: member count as a second line under the group name, matching the
          // conversation list. Hidden until the roster hydrates so it never flashes
          // "0 members".
          return (
            <View style={styles.headerLeftCluster} testID="chat-title">
              {back}
              {avatar}
              <View style={[styles.headerTitleCol, styles.headerTitleFlex]}>
                <Text style={styles.headerTitleText} numberOfLines={1}>
                  {convoDisplayName(convo)}
                </Text>
                {groupMemberCount > 0 && (
                  <Text style={styles.headerTitleSub} numberOfLines={1} testID="chat-header-membercount">
                    {groupMemberCount === 1
                      ? '1 member'
                      : `${groupMemberCount} members`}
                  </Text>
                )}
              </View>
            </View>
          );
        }
        const shortHex =
          convo.peerAddress != null
            ? shortAddress(convo.peerAddress)
            : `peer #${convo.convoPk}`;
        const labelled = convo.nickname != null && convo.nickname.length > 0;
        return (
          <View style={styles.headerLeftCluster} testID="chat-title">
            {back}
            {avatar}
            <View style={[styles.headerTitleCol, styles.headerTitleFlex]}>
              {labelled ? (
                <>
                  <View style={styles.headerNameRow}>
                    <Text style={styles.headerTitleText} numberOfLines={1}>
                      {convo.nickname}
                    </Text>
                    {convo.verified && <VerifiedBadge size={14} />}
                  </View>
                  <View style={styles.headerSubRow}>
                    <Text style={styles.headerTitleSub} numberOfLines={1}>
                      {shortHex}
                    </Text>
                    {/* #174: mapped-to-mesh indicator — green mesh glyph + name,
                        same treatment as the GroupInfo member badge / contact row. */}
                    {peerMesh != null && (
                      <View style={styles.headerMeshTag} testID="chat-header-mesh">
                        <MeshIcon size={12} color={MESH_GREEN} />
                        <Text
                          style={[styles.headerTitleSub, {color: MESH_GREEN}]}
                          numberOfLines={1}>
                          {peerMesh.name || 'mesh'}
                        </Text>
                      </View>
                    )}
                  </View>
                </>
              ) : (
                <>
                  <View style={styles.headerNameRow}>
                    <Text style={styles.headerTitleText} numberOfLines={1}>
                      {shortHex}
                    </Text>
                    {convo.verified && <VerifiedBadge size={14} />}
                  </View>
                  {peerMesh != null && (
                    <View style={styles.headerSubRow} testID="chat-header-mesh">
                      <MeshIcon size={12} color={MESH_GREEN} />
                      <Text
                        style={[styles.headerTitleSub, {color: MESH_GREEN}]}
                        numberOfLines={1}>
                        {peerMesh.name || 'mesh'}
                      </Text>
                    </View>
                  )}
                </>
              )}
              {/* #212: honest last-seen (1:1 only) — from the last inbound message,
                  no heartbeat. Hidden when we've never received from this peer. */}
              {!isGroup &&
                convo != null &&
                formatLastSeen(convo.lastInboundAt, Date.now()).length > 0 && (
                  <Text
                    style={styles.headerLastSeen}
                    numberOfLines={1}
                    testID="chat-header-lastseen">
                    {formatLastSeen(convo.lastInboundAt, Date.now())}
                  </Text>
                )}
              {/* #212: honest mesh presence — "heard Xm ago", green when live. */}
              {!isGroup && peerPresence != null && (
                <Text
                  style={[
                    styles.headerLastSeen,
                    peerPresence.live && {color: MESH_GREEN},
                  ]}
                  numberOfLines={1}
                  testID="chat-header-meshpresence">
                  📡 {peerPresence.text}
                </Text>
              )}
              {/* #246: live BLE presence. Unlike Logos (async), Bluetooth
                  presence is real-time/binary — the peer is heard right now or
                  not. Blue (#243) "nearby" when reachable over the BLE mesh. */}
              {!isGroup && bleReachable && (
                <Text
                  style={[styles.headerLastSeen, {color: BLE_BLUE}]}
                  numberOfLines={1}
                  testID="chat-header-blepresence">
                  ● nearby
                </Text>
              )}
            </View>
          </View>
        );
      },
      headerTitle: () => <View />,
      headerRight: () => (
        <Pressable
          onPress={() => setMenuOpen(true)}
          hitSlop={10}
          style={styles.headerBtn}
          testID="chat-overflow">
          <EllipsisIcon size={22} color={colors.text} />
        </Pressable>
      ),
    });
    // Every reactive value the header closure READS must be listed here — the
    // options are a snapshot, not a render. Pinned by chatHeaderDeps.test.ts.
  }, [
    navigation,
    convo,
    isGroup,
    peerMesh,
    peerPresence,
    bleReachable,
    groupMemberCount,
    storageOff,
  ]);

  // #193/docs/test-matrix: composer/liveness state is derived by the pure,
  // unit-tested deriveComposerState — the screen only maps sendColorKind→color
  // and ANDs canSend with the live text/busy state.
  const meshMode = (convo?.meshMode ?? false) && convo?.meshChannelIdx != null;
  const cs = deriveComposerState({
    isGroup,
    isMesh,
    meshMode,
    meshStatus,
    nodeStatus,
    liveness,
    createdByMe: convo?.createdByMe ?? false,
    bleReachable,
  });
  const {running, connecting, overMesh, meshLive, dead, canRevive} = cs;
  // #255/#261: a staged location OR image counts as sendable payload even with no text.
  const canSend =
    cs.canSendBase &&
    (text.trim().length > 0 ||
      pendingLoc != null ||
      pendingImages.length > 0 ||
      pendingVideo != null) &&
    !busy;
  const sendColor =
    cs.sendColorKind === 'mesh'
      ? MESH_GREEN
      : cs.sendColorKind === 'ble'
      ? BLE_BLUE
      : cs.sendColorKind === 'accent'
      ? colors.accent
      : cs.sendColorKind === 'connecting'
      ? colors.nodeConnecting
      : colors.nodeOffline;
  // #313: gently pulse the send button while the node is connecting (yellow `nodeConnecting`
  // tint above); steady otherwise.
  const sendPulse = React.useRef(new Animated.Value(1)).current;
  const sendConnecting = cs.sendColorKind === 'connecting';
  useEffect(() => {
    if (!sendConnecting) {
      sendPulse.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sendPulse, {toValue: 0.45, duration: 700, useNativeDriver: true}),
        Animated.timing(sendPulse, {toValue: 1, duration: 700, useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      sendPulse.setValue(1);
    };
  }, [sendConnecting, sendPulse]);
  // #206: the send button is only active when there's text to send; gray otherwise.
  // #255: …or a location is staged in the composer.
  const canSendText = text.trim().length > 0;
  const canSendComposer =
    canSendText ||
    pendingLoc != null ||
    pendingImages.length > 0 ||
    pendingVideo != null;
  // #150: MTU-aware composer. A LoRa text packet is byte-capped (UTF-8), so the
  // budget only applies when the send will ACTUALLY leave over the radio — which
  // is exactly sendColorKind==='mesh' (BLE fragments; Logos has no radio MTU).
  const budget = composerBudget({text, overLora: cs.sendColorKind === 'mesh'});

  // #168 (Phase 2b): mesh-mirror banner state. Shown on a Logos group when a radio
  // is connected and the group is either already mirrored or has mapped members.
  const radioConnected = meshStatus === 'connected';
  const mappedMembers = (groupMembers ?? []).filter(m => !m.isSelf && m.meshPubkey != null);
  const otherMembers = (groupMembers ?? []).filter(m => !m.isSelf);
  const nodeOffline = !running && !connecting;
  // #168 refinement (point 1): the banner is OFFLINE-ONLY. It renders only when
  // the group is ALREADY mirroring, or the Logos node is offline (the fallback
  // prompt). When the node is online and not yet mirroring, the banner stays
  // hidden — the user enables mirroring from the ⋮ menu instead.
  const showMeshBanner =
    isGroup && !isMesh && radioConnected && (meshMode || nodeOffline);
  const [switching, setSwitching] = useState(false);

  const doSwitchToMesh = async () => {
    setSwitching(true);
    try {
      const {invited} = await switchGroupToMesh(convoPk);
      ToastAndroid.show(
        `Mesh mirroring on — invited ${invited} mapped member${invited === 1 ? '' : 's'}`,
        ToastAndroid.SHORT,
      );
    } catch (e: any) {
      useNodeStore.setState({error: `switch failed: ${e?.message ?? e}`});
    } finally {
      setSwitching(false);
    }
  };
  const doSwitchToLogos = async () => {
    setSwitching(true);
    try {
      await switchGroupToLogos(convoPk);
      ToastAndroid.show('Mesh mirroring stopped', ToastAndroid.SHORT);
    } catch (e: any) {
      useNodeStore.setState({error: `switch failed: ${e?.message ?? e}`});
    } finally {
      setSwitching(false);
    }
  };

  // #168 (point 4): mesh entries appended to a group's ⋮ menu — only with a radio
  // connected. Enable/stop mirroring (labels only; actions unchanged) plus an
  // always-present "About mesh mirroring" that opens the explainer.
  const meshMenuItems: MenuItem[] = [];
  if (isGroup && !isMesh && radioConnected) {
    if (meshMode) {
      meshMenuItems.push({
        key: 'mesh-stop',
        label: 'Stop mesh mirroring',
        icon: <MeshIcon color={MESH_GREEN} />,
        onPress: doSwitchToLogos,
      });
    } else if (mappedMembers.length > 0) {
      meshMenuItems.push({
        key: 'mesh-add',
        label: 'Add mesh mirroring',
        icon: <MeshIcon color={MESH_GREEN} />,
        onPress: doSwitchToMesh,
      });
    }
    meshMenuItems.push({
      key: 'mesh-about',
      label: 'About mesh mirroring',
      icon: <InfoIcon color={colors.textDim} />,
      onPress: () => setMeshInfoOpen(true),
    });
  }

  // #37: older history loads at the visual TOP of an inverted list — which is
  // where onEndReached fires. The store guards against duplicate/at-end loads.
  const onLoadOlder = useCallback(() => {
    loadMoreMessages(convoPk).catch(() => {});
  }, [loadMoreMessages, convoPk]);

  // #195: re-invite an invitee whose join never landed — re-runs addMember,
  // which pushes a fresh "invited" line and re-arms the join timeout. Honest:
  // this only re-sends the invite, it does not guarantee they'll receive it.
  const onReinvite = useCallback(
    (address: string) => {
      addMember(convoPk, address).catch(e => {
        const msg = String(e?.message ?? e);
        // #291: a not-yet-joined member is ALREADY in the MLS group, so re-adding
        // is invalid ("Duplicate signature key in proposals and group"). That's
        // benign — they'll get their Welcome via store catch-up once they're
        // online. Show a calm note instead of the alarming red error banner.
        if (/duplicate signature key|already a? ?member/i.test(msg)) {
          ToastAndroid.show(
            'Already invited — waiting for them to come online',
            ToastAndroid.LONG,
          );
          return;
        }
        useNodeStore.setState({error: `re-invite failed: ${msg}`});
      });
    },
    [addMember, convoPk],
  );

  const doSend = async () => {
    if (!canSend) {
      return;
    }
    const t = text.trim();
    const loc = pendingLoc; // #255: staged location, if any
    const imgs = pendingImages; // #261: staged images, if any
    const vid = pendingVideo; // #307: staged video, if any
    const reply = replyDraft; // #295: reply target, if any
    setText('');
    setPendingLoc(null);
    setPendingImages([]);
    setPendingVideo(null);
    setReplyDraft(null);
    try {
      setBusy(true);
      // #191: no more silent revive-on-send. A dead group is restarted only via
      // the explicit "Restart group" action (which shows what it does), so the
      // composer isn't even reachable while dead — a plain send is all this is.
      if (t) {
        // #295: a reply wraps the typed text in a reply1: marker → the peer renders
        // the quoted header. A plain message sends the text as-is.
        await send(convoPk, reply != null ? encodeReply(reply.key, t) : t);
      }
      // #261: send the staged images (each its own message), after any text.
      if (imgs.length > 0) {
        await sendStagedImages(convoPk, imgs, hqActive);
      }
      // #305/#307: send the staged video — compress→upload→send with an in-chat ring.
      // Fire-and-forget: the mediaSends bubble tracks progress, so Send returns at once.
      if (vid != null) {
        sendStagedVideo(convoPk, vid);
      }
      // #255: send the confirmed location as its own message (after any text).
      if (loc != null) {
        await sendLocationValue(convoPk, loc);
      }
    } catch (e: any) {
      useNodeStore.setState({error: `send failed: ${e?.message ?? e}`});
    } finally {
      setBusy(false);
    }
  };

  // #191: explicit, honest restart of a dead group (creator only). Creates a new
  // MLS group and re-invites the roster (the (i) explains the Logos limitation +
  // that a new group appears in the desktop module); local history is kept.
  const doRestart = async () => {
    try {
      setReviving(true);
      await recreateGroup(convoPk);
    } catch (e: any) {
      useNodeStore.setState({error: `restart failed: ${e?.message ?? e}`});
    } finally {
      setReviving(false);
    }
  };

  // #206/#207: the image action picks MULTIPLE photos (album). Guards live in the
  // store; keep a busy flag so a double-tap can't open two pickers.
  const withAttaching = async (fn: () => Promise<void>) => {
    if (attaching || recording) return;
    setAttaching(true);
    try {
      await fn();
    } finally {
      setAttaching(false);
    }
  };
  // #261: pick/capture STAGES the images (appended to the tray) — nothing is sent
  // until the user taps Send, mirroring the location flow.
  const onPickImages = () =>
    withAttaching(async () => {
      const picked = await stageImages(convoPk);
      if (picked.length > 0) {
        setPendingImages(prev => [...prev, ...picked].slice(0, MAX_STAGED_IMAGES));
      }
    });
  const onCamera = () =>
    withAttaching(async () => {
      const picked = await stageCameraPhoto(convoPk);
      if (picked.length > 0) {
        setPendingImages(prev => [...prev, ...picked].slice(0, MAX_STAGED_IMAGES));
      }
    });
  // #307: the Video button — pick + STAGE one video (poster preview), sent on Send.
  const onPickVideo = () =>
    withAttaching(async () => {
      const vid = await stageVideo(convoPk);
      if (vid != null) setPendingVideo(vid);
    });
  // #255: acquire a fix and STAGE it in the composer (preview + confirm) instead
  // of sending on the first tap.
  const onLocation = () =>
    withAttaching(async () => {
      const loc = await fetchLocation();
      if (loc != null) setPendingLoc(loc);
    });

  // #205: tick the elapsed timer + auto-finalize when the 120s cap is hit.
  useEffect(() => {
    if (!recording) return undefined;
    const t = setInterval(() => setRecElapsed(e => e + 1), 1000);
    const sub = DeviceEventEmitter.addListener('AudioRecorderEvent', (e: any) => {
      if (e?.eventType === 'maxDuration') finishRecord(true);
    });
    return () => {
      clearInterval(t);
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const requestRecordPerm = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    try {
      const res = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      );
      return res === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  };

  const onStartRecord = async () => {
    if (attaching || recording) return;
    if (!running) {
      useNodeStore.setState({error: 'start the node to record a voice note'});
      return;
    }
    const granted = await requestRecordPerm();
    if (!granted) {
      ToastAndroid.show('Microphone permission denied', ToastAndroid.SHORT);
      return;
    }
    try {
      await AudioRecorder.startRecording();
      setRecElapsed(0);
      setRecording(true);
    } catch (e: any) {
      useNodeStore.setState({error: String(e?.message ?? e)});
    }
  };
  const finishRecord = async (sendIt: boolean) => {
    if (!recording) return;
    setRecording(false);
    try {
      if (sendIt) {
        const rec = parseRecording(await AudioRecorder.stopRecording());
        if (rec != null && rec.durationMs >= 800) {
          await sendVoice(convoPk, rec);
        } else {
          ToastAndroid.show('Too short', ToastAndroid.SHORT);
        }
      } else {
        await AudioRecorder.cancelRecording();
      }
    } catch (e: any) {
      // stopRecording rejects "empty"/"too short" on a tap — treat as cancel.
    }
  };

  const onSubmit = () => {
    // A send goes through if the mesh radio is live (mesh path), the Logos node is
    // running (a mesh-mirrored group falls back to Logos when the radio is down),
    // OR — #237 — the 1:1 peer is reachable over the BLE mesh (works even with
    // Logos off, since MLS encrypts locally and BLE carries the ciphertext).
    // Otherwise say which transport is missing.
    if (meshLive || running || bleReachable) {
      doSend();
    } else if (isMesh) {
      // Pure mesh channel with no radio — nothing to fall back to.
      ToastAndroid.show('Mesh radio not connected', ToastAndroid.SHORT);
    } else if (connecting) {
      // Keep the draft; just tell the user to wait.
      ToastAndroid.show('Logos node connecting…', ToastAndroid.SHORT);
    } else if (bleStatus === 'on') {
      // #237: Logos is off and BLE is on but this contact isn't in range.
      useNodeStore.setState({
        error: 'Logos off — this contact isn’t nearby over Bluetooth',
      });
    } else {
      // #183: name the transport — the LOGOS node is down (a mirrored group with
      // the radio also down lands here: neither transport is available).
      useNodeStore.setState({error: 'Logos node offline'});
    }
  };

  // #188: interleave system lines (invited/joined/left/mirror) into the timeline
  // by time, so a message sent AFTER an event renders below it — instead of the
  // old bottom-pinned footer, which put every system line under every message.
  // (`dead`/`reviving` stay separate — they are current-state banners, not
  // historical events.)
  // #264: author of a message, derived consistently on every device (own → me,
  // else the verified sender / the 1:1 peer) — the basis for the cross-device key.
  const peerAddr = convo?.peerAddress ?? null;
  const authorOf = useCallback(
    (m: Message) =>
      (m.direction === 'out' ? myAddress : m.senderAccount ?? peerAddr) ?? '',
    [myAddress, peerAddr],
  );
  // #264: fold every react1: marker into per-message aggregates (keyed by target).
  // CHRONOLOGICAL order matters — `messages` is newest-first, but foldReactions
  // replays +/- in sequence, so a remove must come AFTER its add. Sort ascending.
  const reactionsByKey = useMemo(() => {
    const events: {reactor: string; reaction: NonNullable<ReturnType<typeof parseReaction>>}[] = [];
    const markers = messages
      .filter(m => isReactionContent(m.text))
      .slice()
      .sort((a, b) => a.at - b.at || a.msgPk - b.msgPk);
    for (const m of markers) {
      const r = parseReaction(m.text);
      if (r == null) continue;
      events.push({reactor: authorOf(m), reaction: r});
    }
    return foldReactions(events, myAddress ?? '');
  }, [messages, authorOf, myAddress]);

  // #295: index every non-marker message by its cross-device key, so a reply can
  // resolve the ORIGINAL it quotes (author + snippet). First occurrence wins.
  const msgByKey = useMemo(() => {
    const map = new Map<string, {author: string; snippet: string}>();
    for (const m of messages) {
      if (isFoldedMarker(m.text)) continue;
      const k = messageKey(authorOf(m), m.text);
      if (!map.has(k)) map.set(k, {author: authorOf(m), snippet: quotePreview(m.text)});
    }
    return map;
  }, [messages, authorOf]);

  // #295: jump to a quoted message by its key (best-effort — no-op if not loaded).
  const scrollToKey = useCallback(
    (key: string) => {
      const idx = rowsRef.current.findIndex(
        r => r.kind === 'msg' && messageKey(authorOf(r.msg), r.msg.text) === key,
      );
      if (idx >= 0) {
        listRef.current?.scrollToIndex({index: idx, animated: true, viewPosition: 0.5});
      }
    },
    [authorOf],
  );

  // #266: fold pin1: markers (chronological) → the currently-pinned message key.
  const pinnedKey = useMemo(() => {
    const events = messages
      .filter(m => isPinContent(m.text))
      .slice()
      .sort((a, b) => a.at - b.at || a.msgPk - b.msgPk)
      .map(m => parsePin(m.text))
      .filter((p): p is NonNullable<typeof p> => p != null);
    return foldPins(events);
  }, [messages]);
  // The pinned message itself (for the top bar), matched by its cross-device key.
  const pinnedMsg = useMemo(
    () =>
      pinnedKey == null
        ? null
        : messages.find(
            m =>
              !isReactionContent(m.text) &&
              !isPinContent(m.text) &&
              !isLeaveContent(m.text) &&
              !isPfpContent(m.text) &&
              messageKey(authorOf(m), m.text) === pinnedKey,
          ) ?? null,
    [pinnedKey, messages, authorOf],
  );

  // #283: fold leave1: markers → mark each leaver "left" (renders the "X left"
  // line). setMemberStatus is idempotent on an unchanged status (#285), so this
  // is safe to re-run on every messages change.
  useEffect(() => {
    for (const m of messages) {
      if (!isLeaveContent(m.text)) continue;
      const leaver = authorOf(m);
      if (leaver && leaver.toLowerCase() !== (myAddress ?? '').toLowerCase()) {
        setMemberStatus(convoPk, leaver, 'left');
      }
    }
  }, [messages, authorOf, myAddress, convoPk, setMemberStatus]);

  // #314: fold pfp1: markers on this timeline → the latest avatar per PEER, pushed into
  // avatarStore so HexAvatar renders it. A peer's marker also lands via chatStore's inbound
  // ingestion; this catch-all covers history already in the DB. My OWN avatar is authoritative
  // from KV/setMine (so Remove sticks) — it is deliberately NOT re-derived from history here.
  useEffect(() => {
    const refs = foldPfps(
      messages.map(m => ({author: authorOf(m), body: m.text, at: m.at, seq: m.msgPk})),
    );
    const store = useAvatarStore.getState();
    const me = (myAddress ?? '').toLowerCase();
    for (const [author, ref] of refs) {
      if (author.toLowerCase() === me) continue;
      // null ⇒ their newest marker was pfp1:clear → drop any cached avatar.
      if (ref == null) store.clearContactAvatar(author);
      else store.setContactAvatar(author, ref);
    }
  }, [messages, authorOf, myAddress]);

  // #344: fold gcfg1: markers on this timeline → the group's storage on/off (newest
  // wins), pushed into chatStore so the composer + render enforce it. A live marker
  // also lands via chatStore's inbound ingestion; this covers history already in the
  // DB (e.g. a marker sent before this session). Only when there IS a gcfg in
  // history do we set it — else hydrateGroupStorage / the KV default stands.
  useEffect(() => {
    const folded = foldGroupCfgs(
      messages.map(m => ({body: m.text, at: m.at, seq: m.msgPk})),
    );
    if (folded == null) return;
    const prev = useChatStore.getState().storageOff[convoPk];
    if (prev !== folded) {
      useChatStore.setState(s => ({
        storageOff: {...s.storageOff, [convoPk]: folded},
      }));
      // #344: announce a transition, but only when there was a KNOWN prior value —
      // an undefined→value fold is initial hydration from history (opening the
      // chat), not a change to report. Real live flips are announced at their
      // source (setGroupStorage / the inbound db_changed fold), and pushSystemLine
      // dedups consecutive dupes, so this only covers a history re-fold.
      if (prev !== undefined) {
        useChatStore
          .getState()
          .pushSystemLine(
            convoPk,
            folded
              ? 'Storage turned off — text & voice only'
              : 'Storage turned on — media enabled',
          );
      }
    }
  }, [messages, convoPk]);

  const rows = useMemo(() => {
    const merged: Array<{at: number; row: Row}> = [
      // Control markers (react1:/pin1:/leave1:/pfp1:/gcfg1:/readd1:) are folded
      // into their own affordances above — never rendered as bubbles.
      ...messages
        .filter(m => !isFoldedMarker(m.text))
        .map(m => ({at: m.at, row: {kind: 'msg' as const, msg: m}})),
      ...(systemLines ?? []).map(sn => ({
        at: sn.at,
        row: {kind: 'sys' as const, sys: sn},
      })),
      // #308: in-flight video sends float at the newest end while they compress/upload.
      ...convoMediaSends.map(ms => ({
        at: ms.startedAt,
        row: {kind: 'media' as const, send: ms},
      })),
    ];
    // inverted list → newest first (index 0 renders at the bottom).
    merged.sort((a, b) => b.at - a.at);
    return merged.map(x => x.row);
  }, [messages, systemLines, convoMediaSends]);
  rowsRef.current = rows; // #295: keep the reply scroll-to lookup current
  const empty = rows.length === 0;

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* #239: persistent trust strip for an UNVERIFIED 1:1 (e.g. a contact
          bootstrapped over BLE). Stays until the user verifies out of band, so a
          single tap-through of the identity card doesn't silently grant trust. */}
      {!isGroup && convo != null && !convo.verified && (
        <View style={styles.unverifiedStrip}>
          <Text style={styles.unverifiedText} numberOfLines={2}>
            ⚠ Unverified — this identity isn’t confirmed. Verify out of band before
            sharing anything sensitive.
          </Text>
          <Pressable
            onPress={() =>
              setLabelTarget({
                address: convo.peerAddress,
                label: convo.nickname,
                verified: convo.verified,
              })
            }
            hitSlop={8}>
            <Text style={styles.unverifiedVerify}>Verify</Text>
          </Pressable>
        </View>
      )}
      {/* #168 (Phase 2b): mesh-mirror banner. On a Logos group with a radio
          connected: either the group is already on its MeshCore mirror, or it can
          be switched. The "N/M mapped" is tappable → Group info (mapping lives
          there). More assertive when the Logos node is offline. */}
      {showMeshBanner && (
        <View
          style={[
            styles.meshBanner,
            meshMode && styles.meshBannerOn,
            !meshMode && nodeOffline && styles.meshBannerAlert,
          ]}>
          <View style={styles.meshBannerText}>
            <Text
              style={[
                type.label,
                {
                  color: meshMode
                    ? MESH_GREEN
                    : nodeOffline
                    ? colors.nodeOffline
                    : colors.text,
                },
              ]}
              numberOfLines={2}>
              {meshMode
                ? 'Mesh mirroring on — over the mesh, not MLS'
                : nodeOffline
                ? 'Logos node offline — reach mapped members over the mesh'
                : 'Logos node online'}
            </Text>
            <Pressable
              onPress={() => navigation.navigate('GroupInfo', {convoPk})}
              hitSlop={8}
              testID="mesh-banner-mapped">
              <Text style={[type.caption, {color: colors.textDim}]}>
                {mappedMembers.length}/{otherMembers.length} mapped to mesh ›
              </Text>
            </Pressable>
          </View>
          {/* #168 (point 3): (i) explainer, next to the mesh action. */}
          <Pressable
            onPress={() => setMeshInfoOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="About mesh mirroring"
            style={styles.meshInfoBtn}
            testID="mesh-info">
            <InfoIcon color={meshMode ? MESH_GREEN : colors.textDim} />
          </Pressable>
          <Pressable
            style={[styles.meshBannerBtn, meshMode ? styles.meshBannerBtnBack : styles.meshBannerBtnGo]}
            disabled={switching}
            onPress={meshMode ? doSwitchToLogos : doSwitchToMesh}
            testID="mesh-switch">
            {switching ? (
              <ActivityIndicator color={meshMode ? colors.textDim : colors.onAccent} />
            ) : (
              <Text
                style={[
                  type.label,
                  {color: meshMode ? colors.textDim : colors.onAccent},
                ]}>
                {meshMode ? 'Stop mesh mirroring' : 'Add mesh mirroring'}
              </Text>
            )}
          </Pressable>
        </View>
      )}
      {/* #266: pinned-message bar — tap to jump to it; the creator can unpin. */}
      {pinnedMsg != null && (
        <Pressable
          style={styles.pinBar}
          testID="pin-bar"
          onPress={() => {
            const idx = rows.findIndex(
              r => r.kind === 'msg' && r.msg.msgPk === pinnedMsg.msgPk,
            );
            if (idx >= 0) {
              listRef.current?.scrollToIndex({index: idx, viewPosition: 0.5, animated: true});
            }
          }}>
          <PinIcon size={16} color={colors.accent} />
          <View style={styles.pinBarText}>
            {/* #309: no "Pinned" label — the pin icon is descriptive enough; keeps the
                banner to a single compact line. */}
            <Text style={styles.pinBarMsg} numberOfLines={1}>
              {parseImageLocal(pinnedMsg.text) != null
                ? '📷 Photo'
                : parseVoiceLocal(pinnedMsg.text) != null
                ? '🎤 Voice message'
                : parseLocation(pinnedMsg.text) != null
                ? '📍 Location'
                : parseRelay(pinnedMsg.text)?.text ?? pinnedMsg.text}
            </Text>
          </View>
          {isGroup && (convo?.createdByMe ?? false) && (
            <Pressable
              onPress={() =>
                pinMessage(convoPk, pinnedKey!, '-').catch(() =>
                  useNodeStore.setState({error: 'unpin failed'}),
                )
              }
              hitSlop={10}
              testID="pin-bar-unpin">
              <Text style={styles.pinBarClear}>✕</Text>
            </Pressable>
          )}
        </Pressable>
      )}
      <FlatList
        ref={listRef}
        inverted
        data={rows}
        onScrollToIndexFailed={info => {
          // Inverted + variable heights: nudge, then retry once measured.
          listRef.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: false,
          });
        }}
        keyExtractor={r =>
          r.kind === 'msg'
            ? `m${r.msg.msgPk}`
            : r.kind === 'media'
            ? `x${r.send.id}`
            : `s${r.sys.id}`
        }
        renderItem={({item}) => {
          if (item.kind === 'media') {
            return <MediaSendBubble send={item.send} />;
          }
          if (item.kind === 'sys') {
            const info = item.sys.info;
            return (
              <SystemLine
                testID={`system-${item.sys.id}`}
                onInfo={
                  info === 'invited-wait'
                    ? () => setInvitedInfoOpen(true)
                    : undefined
                }
                // #195: a stuck invite offers a one-tap re-invite for its address.
                // #350: a desync notice offers one-tap "Ask to be re-added" — it
                // broadcasts a readd1: request to the group's members; the creator's
                // app auto does remove-then-add and a fresh Welcome resyncs us.
                actionLabel={
                  info === 'join-failed'
                    ? 'Re-invite'
                    : info === 'desynced'
                    ? 'Ask to be re-added'
                    : undefined
                }
                onAction={
                  info === 'join-failed' && item.sys.infoAddress != null
                    ? () => onReinvite(item.sys.infoAddress!)
                    : info === 'desynced'
                    ? () => {
                        // Only claim success once a request actually went out —
                        // requestReadd throws if it reached nobody.
                        requestReadd(convoPk)
                          .then(() =>
                            ToastAndroid.show(
                              'Re-add requested — the group creator will resync you',
                              ToastAndroid.SHORT,
                            ),
                          )
                          .catch(e =>
                            useNodeStore.setState({
                              error: `re-add request failed: ${e?.message ?? e}`,
                            }),
                          );
                      }
                    : undefined
                }>
                {item.sys.text}
              </SystemLine>
            );
          }
          const m = item.msg;
          // #330: a shared-contact card (addr1:) is a real, visible message —
          // render it as a tappable card for BOTH incoming and outgoing bubbles.
          if (isAddrContent(m.text)) {
            const shared = parseAddr(m.text);
            if (shared != null) {
              return (
                <AddressCard
                  address={shared.address}
                  label={shared.label}
                  onAdd={() => onAddSharedContact(shared.address, shared.label)}
                  onView={() =>
                    setAddressTarget({
                      address: shared.address,
                      label: shared.label ?? null,
                      verified: false,
                    })
                  }
                />
              );
            }
          }
          const attribution = resolveAttribution(m, isGroup, convo);
          const rKey = messageKey(authorOf(m), m.text); // #264
          // #295: if this bubble is a reply, resolve the quoted original.
          const parsedReply = parseReply(m.text);
          const quotedTarget =
            parsedReply != null ? msgByKey.get(parsedReply.key) ?? null : null;
          const quoted =
            parsedReply != null
              ? {
                  author:
                    quotedTarget == null
                      ? 'message'
                      : myAddress != null &&
                        quotedTarget.author.toLowerCase() === myAddress.toLowerCase()
                      ? 'You'
                      : describePeer(quotedTarget.author),
                  snippet: quotedTarget?.snippet ?? '(not loaded)',
                }
              : null;
          return (
            <Bubble
              msg={m}
              attribution={attribution}
              storageOff={storageOff}
              quoted={quoted}
              replyText={parsedReply?.body}
              onQuotedPress={
                parsedReply != null ? () => scrollToKey(parsedReply.key) : undefined
              }
              reactions={reactionsByKey.get(rKey)}
              onReact={(emoji, mine) =>
                sendReaction(convoPk, rKey, emoji, mine ? '-' : '+').catch(() =>
                  useNodeStore.setState({error: 'reaction failed'}),
                )
              }
              onShowReactors={r => {
                // #293: the reactor addresses are already folded — surface them.
                const who = r.reactors
                  .map(a =>
                    myAddress != null && a.toLowerCase() === myAddress.toLowerCase()
                      ? 'You'
                      : describePeer(a),
                  )
                  .join('\n');
                Alert.alert(`${r.emoji}  ·  ${r.count}`, who);
              }}
              avatarKind={
                convo ? convoKind({transport: convo.transport, isGroup: false}) : 'contact'
              }
              onRetry={() => retry(convoPk, m.msgPk)}
              onOpenMedia={openMediaViewer}
              onOpenLocation={loc =>
                Linking.openURL(geoUri(loc)).catch(() =>
                  ToastAndroid.show('No maps app', ToastAndroid.SHORT),
                )
              }
              onLongPress={pageY => {
                setBubbleY(pageY);
                setBubbleTarget({
                  msgPk: m.msgPk,
                  reactionKey: rKey,
                  own: m.direction === 'out',
                  isGroup,
                  text: m.text,
                  address: attribution?.address ?? null,
                  label: attribution?.label ?? null,
                });
              }}
            />
          );
        }}
        // flex:1 so the list owns the free space and the composer keeps its
        // intrinsic height. When there are NO messages, an inverted list under
        // KeyboardAvoidingView mismeasures and collapses the composer to ~0
        // height (the empty-group bug from M2'). Fix (#84): a flexGrow content
        // container + a flex:1 empty spacer that durably fills the list so the
        // composer never gets crushed — survives members_changed + keyboard.
        style={styles.list}
        contentContainerStyle={[
          styles.listContent,
          empty && styles.listContentEmpty,
        ]}
        ListEmptyComponent={<View style={styles.emptySpacer} />}
        // #37: inverted list → the visual TOP is the list "end", so scrolling up
        // into older history triggers onEndReached. A short page stops it
        // (reachedEnd), and the store dedupes concurrent loads.
        onEndReached={onLoadOlder}
        onEndReachedThreshold={0.4}
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.loadMoreSpinner} testID="load-older-spinner">
              <ActivityIndicator color={colors.textDim} />
            </View>
          ) : null
        }
      />
      {/* #112 system lines — flex rules, never wrapping dash characters. */}
      {dead && (
        <SystemLine testID="group-dead-line">
          Group ended when the app restarted
        </SystemLine>
      )}
      {reviving && (
        <SystemLine testID="group-reviving-line">Re-creating the group…</SystemLine>
      )}
      {/* #188: per-member "invited/joined/left" + mirror lines now interleave
          into the timeline above (by time), not as a footer under every message. */}
      {dead ? (
        // #191: a dead group offers an EXPLICIT action + an (i) explainer, never
        // a silent revive-on-send. Creator → "Restart group" (recreate in place,
        // keep history); member → "Create new group" (can't honestly prefill a
        // roster, #95). The (i) explains the Logos limitation + that a new group
        // appears in the desktop module.
        <View style={styles.deadFooter}>
          {/* #113 member view: put the explanation ON TOP + name it a known
              limitation we're fixing, then offer a secondary "Ping creator" that
              opens a DM with the group's creator prefilled with a re-create ask —
              members can't honestly re-create the roster themselves (#95). */}
          {!canRevive && (
            <Text style={styles.deadHint} testID="dead-member-hint">
              Only the group's creator can re-create it — then the conversation
              continues right here. This is a known limitation we're fixing.
            </Text>
          )}
          <View style={styles.deadFooterRow}>
            <View style={styles.deadFooterBtn}>
              <ActionButton
                label={canRevive ? 'Restart group' : 'Ping creator'}
                variant={canRevive ? 'primary' : 'secondary'}
                testID={canRevive ? 'restart-group' : 'ping-creator'}
                onPress={
                  canRevive
                    ? () => {
                        if (!reviving) doRestart();
                      }
                    : () => {
                        // #442: address the group's ACTUAL recorded creator (from
                        // authenticated MLS state), not the first member on the roster
                        // — a joiner's roster order doesn't identify the creator. Fall
                        // back to a roster guess only for pre-#349 groups that record no
                        // creator natively (groupCreator resolves null there).
                        (async () => {
                          let creator: string | null = null;
                          try {
                            creator = await LogosChat.groupCreator(convoPk);
                          } catch {
                            // native unavailable — fall through to the roster guess
                          }
                          if (creator == null) {
                            creator =
                              (groupMembers ?? []).find(m => !m.isSelf)?.address ??
                              null;
                          }
                          if (creator == null) {
                            useNodeStore.setState({
                              error: 'Creator unknown — no member to ping yet',
                            });
                            return;
                          }
                          const gname =
                            convo != null
                              ? convoDisplayName(convo)
                              : route.params.convoName;
                          openDirectWith(
                            creator,
                            `"${gname}" ended — could you re-create it?`,
                          );
                        })();
                      }
                }
              />
            </View>
            <Pressable
              onPress={() => setRestartInfoOpen(true)}
              hitSlop={10}
              style={styles.deadInfoBtn}
              testID="restart-info">
              <InfoIcon size={22} color={colors.textDim} />
            </Pressable>
          </View>
        </View>
      ) : recording ? (
        // #205/#257: recording a voice note — the live waveform gets its own full-
        // width line above a controls row (timer · Cancel · Send).
        <View style={styles.recBar}>
          <RecordingWaveform />
          <View style={styles.recControls}>
            <View style={styles.recDot} />
            <Text style={styles.recTime} testID="rec-timer">
              {Math.floor(recElapsed / 60)}:{(recElapsed % 60).toString().padStart(2, '0')}
              <Text style={styles.recCap}>
                {' '}/ {Math.floor(MAX_RECORDING_MS / 60000)}:00
              </Text>
            </Text>
            <View style={{flex: 1}} />
            <Pressable
              style={styles.recCancel}
              onPress={() => finishRecord(false)}
              testID="rec-cancel">
              <Text style={{color: colors.textDim}}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.send, {backgroundColor: sendColor}]}
              onPress={() => finishRecord(true)}
              testID="rec-send">
              <SendIcon mesh={false} color={colors.onAccent} />
            </Pressable>
          </View>
        </View>
      ) : isMesh ? (
        // Mesh: single-line, text only. #150: no hard char cap — the send is
        // byte-budgeted (LoRa MTU) and oversize is handled honestly on send.
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Message…"
            placeholderTextColor={colors.textFaint}
            multiline
            testID="composer-input"
          />
          <View style={styles.sendCol}>
            <Text
              style={[styles.charCount, budget.over && styles.charCountOver]}
              testID="composer-charcount">
              {budget.label}
            </Text>
            <AnimatedPressable
              style={[
                styles.send,
                {backgroundColor: canSendText ? sendColor : colors.border, opacity: sendPulse},
              ]}
              onPress={onSubmit}
              disabled={!canSendText}
              testID="composer-send">
              <SendIcon mesh color={colors.onAccent} />
            </AnimatedPressable>
          </View>
        </View>
      ) : (
        // #206: 2-line composer — a growing text row + an action-icon row.
        <View style={styles.composerV}>
          {/* #295: reply/quote banner — the message being answered, with a clear ✕. */}
          {replyDraft != null && (
            <View style={styles.replyBanner} testID="reply-banner">
              <View style={styles.replyBannerBar} />
              <View style={styles.replyBannerText}>
                <Text style={styles.replyBannerAuthor} numberOfLines={1}>
                  Replying to {replyDraft.author}
                </Text>
                <Text style={styles.replyBannerSnippet} numberOfLines={1}>
                  {replyDraft.snippet}
                </Text>
              </View>
              <Pressable
                onPress={() => setReplyDraft(null)}
                hitSlop={10}
                testID="reply-banner-clear">
                <Text style={styles.pendingLocClear}>✕</Text>
              </Pressable>
            </View>
          )}
          {/* #150: a mesh-mirrored group whose live transport is the LoRa radio
              is byte-budgeted too — show the same honest budget/oversize line. */}
          {budget.show && (
            <Text
              style={[styles.radioBudget, budget.over && styles.charCountOver]}
              testID="composer-radio-budget">
              {budget.over ? budget.label : `over radio · ${budget.label}`}
            </Text>
          )}
          {/* #261: staged image thumbnails — a removable row above the input, sent
              on Send (mirrors the staged-location chip). */}
          {pendingImages.length > 0 && (
            <View style={styles.pendingRow}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.pendingImages}
                style={styles.pendingScroll}
                testID="pending-images"
                keyboardShouldPersistTaps="handled">
                {pendingImages.map((img, i) => (
                  <View key={i} style={styles.pendingImageWrap}>
                    <Image
                      source={{uri: `data:${img.mime};base64,${img.base64}`}}
                      style={styles.pendingImage}
                    />
                    <Pressable
                      style={styles.pendingImageX}
                      onPress={() =>
                        setPendingImages(prev => prev.filter((_, j) => j !== i))
                      }
                      hitSlop={8}
                      testID={`pending-image-clear-${i}`}>
                      <Text style={styles.pendingImageXText}>✕</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
              {/* #423: borderless HQ toggle — dark gray = off (send standard),
                  orange = on (send high quality via Storage). Disabled + stays
                  gray in a storage-off group (no Storage → no HQ). */}
              <Pressable
                style={styles.qualityToggle}
                onPress={() => {
                  if (!storageOff) setHqPhotos(v => !v);
                }}
                disabled={storageOff}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityState={{selected: hqActive, disabled: storageOff}}
                accessibilityLabel="Send photos in high quality"
                testID="composer-quality">
                <Text style={[styles.qualityText, hqActive && styles.qualityTextOn]}>
                  HQ
                </Text>
              </Pressable>
            </View>
          )}
          {/* #307: staged video — a poster thumbnail with a play badge, removable, sent on Send. */}
          {pendingVideo != null && (
            <View style={styles.pendingImages} testID="pending-video">
              <View style={styles.pendingImageWrap}>
                {pendingVideo.posterPath != null ? (
                  <Image
                    source={{uri: `file://${pendingVideo.posterPath}`}}
                    style={styles.pendingImage}
                  />
                ) : (
                  <View style={[styles.pendingImage, styles.pendingVideoFallback]} />
                )}
                <View style={styles.pendingVideoPlay} pointerEvents="none">
                  <PlayIcon size={18} color="#fff" />
                </View>
                <Pressable
                  style={styles.pendingImageX}
                  onPress={() => setPendingVideo(null)}
                  hitSlop={8}
                  testID="pending-video-clear">
                  <Text style={styles.pendingImageXText}>✕</Text>
                </Pressable>
              </View>
            </View>
          )}
          {/* #255: staged location preview — the user confirms with Send or clears it. */}
          {pendingLoc != null && (
            <View style={styles.pendingLoc} testID="pending-location">
              <LocationIcon size={16} color={colors.accent} />
              <Text style={styles.pendingLocText} numberOfLines={1}>
                {formatLatLng(pendingLoc)}
              </Text>
              <Pressable
                onPress={() => setPendingLoc(null)}
                hitSlop={10}
                testID="pending-location-clear">
                <Text style={styles.pendingLocClear}>✕</Text>
              </Pressable>
            </View>
          )}
          <View style={styles.composerRow1}>
            <TextInput
              style={styles.input}
              value={text}
              onChangeText={setText}
              placeholder="Message…"
              placeholderTextColor={colors.textFaint}
              multiline
              testID="composer-input"
            />
            <AnimatedPressable
              style={[
                styles.send,
                {backgroundColor: canSendComposer ? sendColor : colors.border, opacity: sendPulse},
              ]}
              onPress={onSubmit}
              disabled={!canSendComposer}
              accessibilityRole="button"
              accessibilityLabel={busy ? 'Sending' : 'Send message'}
              accessibilityState={{disabled: !canSendComposer, busy}}
              testID="composer-send">
              {busy ? (
                <Text style={[type.title, {color: colors.onAccent}]}>…</Text>
              ) : (
                <SendIcon mesh={false} color={colors.onAccent} />
              )}
            </AnimatedPressable>
          </View>
          <View style={styles.actionRow}>
            {/* #344: storage off → hide the media affordances (image/camera/GIF/video);
                text/location/mic/reactions/reply stay. No blob is ever sent, so the
                Storage node sees nothing for this group (docs/adr/0002). */}
            {/* #422: photo + camera are ALWAYS available — inline photos ride the
                img1v: base64 path and never touch Storage, so a storage-off group
                must not hide them (only GIF/video below gate on Storage). */}
            <Pressable style={styles.actionBtn} onPress={onPickImages} disabled={attaching} hitSlop={6} accessibilityRole="button" accessibilityLabel="Attach photo" accessibilityState={{disabled: attaching}} testID="composer-image">
              <ImageIcon size={22} color={colors.textDim} />
            </Pressable>
            <Pressable style={styles.actionBtn} onPress={onCamera} disabled={attaching} hitSlop={6} accessibilityRole="button" accessibilityLabel="Take photo" accessibilityState={{disabled: attaching}} testID="composer-camera">
              <CameraIcon size={22} color={colors.textDim} />
            </Pressable>
            <Pressable style={styles.actionBtn} onPress={onLocation} disabled={attaching} hitSlop={6} accessibilityRole="button" accessibilityLabel="Share location" accessibilityState={{disabled: attaching}} testID="composer-location">
              <LocationIcon size={22} color={colors.textDim} />
            </Pressable>
            {!storageOff && (
              <>
                {/* #306: GIF (gifs only) via Logos Storage (encrypt -> upload -> store1: marker). */}
                <Pressable style={styles.actionBtn} onPress={() => sendGif(convoPk)} disabled={attaching} hitSlop={6} accessibilityRole="button" accessibilityLabel="Send a GIF" accessibilityState={{disabled: attaching}} testID="composer-gif">
                  <Text style={styles.gifBtn}>GIF</Text>
                </Pressable>
                {/* #306/#307: dedicated Video button — picks video/* only, stages a poster. */}
                <Pressable style={styles.actionBtn} onPress={onPickVideo} disabled={attaching} hitSlop={6} accessibilityRole="button" accessibilityLabel="Attach video" accessibilityState={{disabled: attaching}} testID="composer-video">
                  <FilmIcon size={22} color={colors.textDim} />
                </Pressable>
              </>
            )}
            <Pressable style={styles.actionBtn} onPress={onStartRecord} disabled={attaching} hitSlop={6} accessibilityRole="button" accessibilityLabel="Record voice message" accessibilityState={{disabled: attaching}} testID="composer-mic">
              <MicIcon size={22} color={colors.textDim} />
            </Pressable>
            {storageOff && (
              <Text style={styles.storageHint} numberOfLines={1} testID="storage-off-hint">
                Storage off — text &amp; voice only
              </Text>
            )}
            {attaching && <ActivityIndicator size="small" color={colors.textDim} />}
          </View>
        </View>
      )}
      <OverflowMenu
        visible={menuOpen}
        items={[...menuItems, ...meshMenuItems]}
        onClose={() => setMenuOpen(false)}
        testID="chat-menu"
      />
      <BubbleActionMenu
        target={bubbleTarget}
        anchorY={bubbleY}
        onClose={() => setBubbleTarget(null)}
        onAddLabel={t =>
          setLabelTarget({
            address: t.address,
            label: t.label,
            verified: isAddressVerified(
              useChatStore.getState().conversations,
              t.address,
            ),
          })
        }
        onSendMessage={openDirectWith}
        onReact={(t, emoji) =>
          sendReaction(convoPk, t.reactionKey, emoji, '+').catch(() =>
            useNodeStore.setState({error: 'reaction failed'}),
          )
        }
        onMoreReactions={t => setEmojiPickerTarget(t)}
        onReply={t => {
          setBubbleTarget(null);
          setReplyDraft({
            key: t.reactionKey,
            author: t.own
              ? 'You'
              : t.label != null && t.label.length > 0
              ? t.label
              : t.address != null
              ? describePeer(t.address)
              : 'message',
            snippet: quotePreview(t.text),
          });
        }}
        pinnedKey={pinnedKey}
        onPin={
          // #266 v1: only the group creator may pin/unpin.
          isGroup && (convo?.createdByMe ?? false)
            ? (t, pinned) =>
                pinMessage(convoPk, t.reactionKey, pinned ? '-' : '+').catch(() =>
                  useNodeStore.setState({error: 'pin failed'}),
                )
            : undefined
        }
        onMapMesh={(address, label) => {
          setBubbleTarget(null);
          setMapTarget({address, label});
        }}
        isMeshMapped={address => meshMemberPubkey(address) != null}
        onForward={content => {
          setBubbleTarget(null);
          setForwardContent(content);
        }}
        onSaveImage={async path => {
          setBubbleTarget(null);
          try {
            await ImagePickerNative.saveImageToGallery(path);
            ToastAndroid.show('Saved to gallery', ToastAndroid.SHORT);
          } catch {
            ToastAndroid.show('Save failed', ToastAndroid.SHORT);
          }
        }}
        onSaveToPhone={async t => {
          // #300: fetch+decrypt the store1: blob (cache hit if already viewed), then save.
          setBubbleTarget(null);
          const m = parseMedia(t.text);
          if (m == null) return;
          try {
            const path = await Storage.downloadDecrypt(m.cid, m.key, m.cap ?? '', m.padded ?? false);
            await ImagePickerNative.saveMediaToGallery(path, m.mime);
            ToastAndroid.show('Saved to phone', ToastAndroid.SHORT);
          } catch {
            ToastAndroid.show('Save failed', ToastAndroid.SHORT);
          }
        }}
        onDelete={msgPk => {
          setBubbleTarget(null);
          // #263: short confirm — local-only delete, no remote unsend.
          Alert.alert(
            'Delete for me?',
            'This removes the message from this device only. The other person still has their copy.',
            [
              {text: 'Cancel', style: 'cancel'},
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => {
                  deleteMessage(convoPk, msgPk).catch(() =>
                    ToastAndroid.show('Delete failed', ToastAndroid.SHORT),
                  );
                },
              },
            ],
          );
        }}
      />
      {/* #298: full emoji picker — react with any emoji, not just the quick 6. */}
      <EmojiGridModal
        visible={emojiPickerTarget != null}
        onClose={() => setEmojiPickerTarget(null)}
        onPick={emoji => {
          const t = emojiPickerTarget;
          setEmojiPickerTarget(null);
          if (t != null) {
            sendReaction(convoPk, t.reactionKey, emoji, '+').catch(() =>
              useNodeStore.setState({error: 'reaction failed'}),
            );
          }
        }}
      />
      <ForwardPicker
        visible={forwardContent != null}
        onClose={() => setForwardContent(null)}
        onPick={pk => {
          const c = forwardContent;
          setForwardContent(null);
          if (c != null) {
            forwardMessage(c, pk);
            ToastAndroid.show('Forwarded', ToastAndroid.SHORT);
            // #343: when the forwarded content is a shared-contact (addr1:) card
            // — the AddressModal "Send" path — jump into that chat afterwards.
            // Plain message forwards (bubble menu) stay put as before.
            if (isAddrContent(c)) {
              const target = useChatStore.getState().conversations[pk];
              navigation.navigate('Chat', {
                convoPk: pk,
                convoName:
                  target != null ? convoDisplayName(target) : `peer #${pk}`,
                isGroup: target?.isGroup ?? false,
              });
            }
          }
        }}
      />
      {/* #210: map a peer to a mesh identity from the chat (local, offline-ok). */}
      <MeshMapModal
        visible={mapTarget != null}
        memberAddress={mapTarget?.address ?? null}
        memberLabel={mapTarget?.label ?? null}
        currentMeshPubkey={
          mapTarget != null ? meshMemberPubkey(mapTarget.address) : null
        }
        onClose={() => setMapTarget(null)}
        onPick={(pubkey, name) => {
          if (mapTarget != null) {
            mapMeshIdentity(convoPk, mapTarget.address, pubkey, name).catch(e =>
              useNodeStore.setState({error: `mesh map failed: ${e?.message ?? e}`}),
            );
          }
          setMapTarget(null);
        }}
        onUnmap={() => {
          if (mapTarget != null) {
            unmapMeshIdentity(convoPk, mapTarget.address).catch(e =>
              useNodeStore.setState({error: `unmap failed: ${e?.message ?? e}`}),
            );
          }
          setMapTarget(null);
        }}
      />
      {/* #479: one full-screen viewer for photos/gifs/videos — pinch-zoom,
          two-tap controls, swipe-down dismiss, swipe left/right across all media. */}
      {viewer != null && (
        <MediaViewer
          items={viewer.items}
          index={viewer.index}
          onClose={() => setViewer(null)}
          authorFor={mediaAuthorFor}
          onForward={content => {
            setViewer(null);
            setForwardContent(content);
          }}
          onSave={saveMediaFromViewer}
          onShare={shareMediaFromViewer}
          storageOff={storageOff}
        />
      )}
      <AddressModal
        visible={addressTarget != null}
        address={addressTarget?.address ?? null}
        label={addressTarget?.label ?? null}
        verified={addressTarget?.verified ?? false}
        onClose={() => setAddressTarget(null)}
        // #330: forward the shown address into a chat (reuses the message
        // forward flow — an addr1: marker sends via the normal text path).
        onForward={(address, label) =>
          setForwardContent(encodeAddr(address, label))
        }
      />
      <LabelModal
        visible={labelTarget != null}
        label={labelTarget?.label ?? null}
        address={labelTarget?.address ?? null}
        avatarKind={
          convo ? convoKind({transport: convo.transport, isGroup: false}) : 'contact'
        }
        verified={labelTarget?.verified ?? false}
        onClose={() => setLabelTarget(null)}
        onSave={(newLabel, verified) =>
          saveLabelFor(labelTarget?.address ?? null, newLabel, verified)
        }
      />
      <MeshInfoModal
        visible={meshInfoOpen}
        onClose={() => setMeshInfoOpen(false)}
      />
      {/* #191: explains the restart-group action + the Logos limitation behind it. */}
      <InfoModal
        visible={restartInfoOpen}
        onClose={() => setRestartInfoOpen(false)}
        title="Restarting a group"
        testID="restart-info-modal">
        <Text style={styles.infoIntro}>
          This is an alpha build. Logos Messaging can't yet reopen a group's
          encryption after the app restarts, so a group from an earlier session
          has to be re-created rather than resumed.
        </Text>
        <InfoSection title="Why">
          Logos groups use MLS, and the current library can't restore a group's
          MLS state from storage after the node restarts (it has no load path
          yet). Until that lands, the group can only be re-created. Tracking:
          logos-chat-android #103 and #187 (a longer-term stored-snapshot fix).
        </InfoSection>
        <InfoSection title="What “Restart group” does">
          It creates a brand-new group under the hood, re-invites the current
          members, and keeps your local chat history here so the conversation
          continues in this same thread.
        </InfoSection>
        <InfoSection title="What the others will see">
          In the desktop Basecamp chat module a new group will appear, and each
          member gets a fresh invite to join it. That's expected — not a bug.
          Members need to accept/join before new messages reach them.
        </InfoSection>
      </InfoModal>
      {/* #192: explains you must wait for the invitee to join before sending. */}
      <InfoModal
        visible={invitedInfoOpen}
        onClose={() => setInvitedInfoOpen(false)}
        title="Adding a member"
        testID="invited-info-modal">
        <Text style={styles.infoIntro}>
          Wait for Logos Messaging to finish adding this member — you'll see a
          “joined” line for them — before you send.
        </Text>
        <InfoSection title="Why it matters">
          A new member can only receive messages sent after they join. There's no
          history replay, so anything you send in the gap between “invited” and
          “joined” will never reach them. Give it a moment; the app also briefly
          holds your first message until the join settles.
        </InfoSection>
      </InfoModal>
      <ErrorToast message={nodeError} onDismiss={clearError} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.canvas},
  // #239 unverified trust strip
  unverifiedStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: '#F59E0B22',
    borderBottomColor: '#F59E0B',
    borderBottomWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  unverifiedText: {...type.caption, color: colors.text, flex: 1},
  unverifiedVerify: {...type.label, color: '#F59E0B'},
  list: {flex: 1},
  listContent: {padding: spacing.lg, gap: spacing.sm},
  listContentEmpty: {flexGrow: 1},
  emptySpacer: {flex: 1},
  // #37: the load-older spinner sits at the visual top of the inverted list.
  loadMoreSpinner: {paddingVertical: spacing.md, alignItems: 'center'},
  bubbleWrap: {maxWidth: layout.bubbleMaxWidthPct, gap: 2},
  wrapPeer: {alignSelf: 'flex-start', alignItems: 'flex-start'},
  wrapOwn: {alignSelf: 'flex-end', alignItems: 'flex-end'},
  bubble: {
    borderRadius: radii.bubble,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  bubblePeer: {backgroundColor: colors.bubblePeer},
  bubbleOwn: {backgroundColor: colors.accent},
  bubblePending: {opacity: 0.55},
  bubbleFailed: {borderColor: colors.unread, borderWidth: 1},
  // #202: an image bubble is a thin 2px frame around the (rounded) image.
  // Must set the SPECIFIC padding keys — RN specificity makes the base bubble's
  // paddingHorizontal/paddingVertical win over a general `padding`.
  bubbleImage: {paddingHorizontal: 2, paddingVertical: 2, overflow: 'hidden'},
  locRow: {gap: 2},
  // #200: full-screen image viewer.
  fsBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fsImage: {width: '100%', height: '100%'},
  // #167: subtle green edge marking a message that rode the mesh (not MLS). A
  // thin border on the "outside" edge of each side + a faint green tint.
  bubbleMeshPeer: {
    borderLeftColor: MESH_GREEN,
    borderLeftWidth: 2,
    backgroundColor: 'rgba(34,197,94,0.08)',
  },
  // Own mesh bubbles fill green (matching the blue BLE fill) — "I sent this over
  // the mesh" reads at a glance; peer bubbles keep the green edge + tint.
  bubbleMeshOwn: {backgroundColor: MESH_GREEN},
  // #243: a message that rode the BLE mesh. Own bubbles fill blue (the user's
  // sent-over-Bluetooth cue); peer bubbles get the mesh-style blue edge + tint.
  bubbleBleOwn: {backgroundColor: BLE_BLUE},
  bubbleBlePeer: {
    borderLeftColor: BLE_BLUE,
    borderLeftWidth: 2,
    backgroundColor: 'rgba(14,165,233,0.10)',
  },
  systemLine: {
    ...type.caption,
    color: colors.textFaint,
    textAlign: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  deadFooter: {
    backgroundColor: colors.pane,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    padding: spacing.md,
  },
  deadFooterRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  deadFooterBtn: {flex: 1},
  deadHint: {
    ...type.caption,
    color: colors.textDim,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.lg, // #113: breathing room between the copy and the button
  },
  deadInfoBtn: {
    padding: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoIntro: {...type.body, color: colors.text, lineHeight: 20},
  attrRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: 2},
  attrLine: {...type.caption, flexShrink: 1},
  timeRow: {flexDirection: 'row', alignItems: 'center'},
  time: {...type.caption, color: colors.textFaint},
  // #167: tiny "via mesh" caption on the time line, in the mesh green.
  viaMesh: {...type.caption, color: MESH_GREEN},
  viaBle: {...type.caption, color: BLE_BLUE},
  headerBtn: {
    minWidth: layout.minTouchTarget,
    minHeight: layout.minTouchTarget,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  // #123: back + avatar + title as one tight left cluster. A small negative left
  // margin pulls the chevron to the screen edge (native-stack pads headerLeft).
  headerLeftCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginLeft: -spacing.sm,
    maxWidth: 300,
  },
  headerBackBtn: {padding: spacing.xs},
  headerTitleFlex: {flexShrink: 1},
  headerTitleRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  // #178: no extra vertical slack — tight line-heights below make the two-line
  // identity block sit as one compact unit, matching the list / GroupInfo rows.
  headerTitleCol: {justifyContent: 'center'},
  headerNameRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.xs},
  headerSubRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.xs},
  // #174: green mesh tag on the header sub-line, capped so a long mesh name can't
  // shove the identity block.
  headerMeshTag: {flexDirection: 'row', alignItems: 'center', gap: spacing.xs, maxWidth: 120},
  // #178: tight line-heights (18 / 14) — same density the conversation list and
  // GroupInfo member rows use, so the header reads identically everywhere.
  headerTitleText: {...type.title, color: colors.text, lineHeight: 18},
  headerTitleSub: {...type.caption, color: colors.textDim, lineHeight: 14},
  // #212: honest last-seen line under the 1:1 title.
  headerLastSeen: {...type.caption, color: colors.textFaint, lineHeight: 13},
  // #168 (Phase 2b): mesh-mirror banner across the top of a group thread.
  meshBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.pane,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  meshBannerOn: {borderBottomColor: MESH_GREEN},
  // #168: assertive when the Logos node is offline — the banner suggests the switch.
  meshBannerAlert: {
    backgroundColor: 'rgba(239,68,68,0.12)',
    borderBottomColor: colors.nodeOffline,
    borderBottomWidth: 2,
  },
  meshBannerText: {flex: 1, gap: 2},
  meshBannerBtn: {
    borderRadius: radii.card,
    paddingHorizontal: spacing.md,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meshBannerBtnGo: {backgroundColor: MESH_GREEN},
  meshBannerBtnBack: {borderColor: colors.border, borderWidth: 1},
  // #168: the (i) explainer affordance sitting between the banner text and action.
  meshInfoBtn: {
    minWidth: layout.minTouchTarget,
    minHeight: layout.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composer: {
    backgroundColor: colors.pane,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.md,
    minHeight: 60, // never collapse (empty-group composer bug, M2')
  },
  input: {
    ...type.body,
    color: colors.text,
    flex: 1,
    backgroundColor: colors.canvas,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    maxHeight: 120,
  },
  // #197: attach-image button, sized to match the send target and stay bottom-aligned.
  attach: {
    width: 44,
    height: 44,
    borderRadius: radii.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendCol: {alignItems: 'center', gap: spacing.xs},
  // #206: two-line composer.
  composerV: {
    backgroundColor: colors.pane,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  composerRow1: {flexDirection: 'row', alignItems: 'flex-end', gap: spacing.md},
  // #255: staged-location preview chip above the input row.
  pendingLoc: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  pendingLocText: {...type.label, color: colors.text, flexShrink: 1},
  pendingLocClear: {...type.label, color: colors.textDim, paddingHorizontal: spacing.xs},
  // #261 staged-image thumbnails
  pendingImages: {gap: spacing.sm, paddingBottom: spacing.xs},
  pendingRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm},
  pendingScroll: {flexShrink: 1},
  // #423: borderless HQ toggle right of the thumbnails — dark gray off, orange on.
  qualityToggle: {paddingHorizontal: 8, paddingVertical: 6},
  qualityText: {color: colors.textFaint, fontSize: 14, fontWeight: '700', letterSpacing: 0.5},
  qualityTextOn: {color: colors.accent},
  pendingImageWrap: {width: 64, height: 64},
  pendingImage: {
    width: 64,
    height: 64,
    borderRadius: radii.card,
    borderColor: colors.border,
    borderWidth: 1,
  },
  pendingImageX: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.canvas,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingImageXText: {color: colors.text, fontSize: 11, lineHeight: 13},
  // #307: staged-video thumbnail play badge + poster fallback.
  pendingVideoFallback: {backgroundColor: 'rgba(0,0,0,0.3)'},
  pendingVideoPlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingLeft: spacing.xs},
  actionBtn: {padding: spacing.xs},
  // #344: composer hint when the group is text-only.
  storageHint: {...type.caption, color: colors.textDim, flexShrink: 1},
  // #205: recording bar.
  recDot: {width: 12, height: 12, borderRadius: 6, backgroundColor: colors.unread},
  recTime: {...type.body, color: colors.text, marginLeft: spacing.sm},
  recCap: {...type.caption, color: colors.textFaint},
  recCancel: {paddingHorizontal: spacing.md, justifyContent: 'center'},
  // #257: live recording waveform — a row of bars scrolling with the real mic
  // amplitude (synthetic oscillation as fallback).
  // #257: the record bar is now a column — a full-width waveform line + a controls row.
  recBar: {
    backgroundColor: colors.pane,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  recControls: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  recWave: {
    alignSelf: 'stretch', // #257: span the full composer width on its own line
    flexDirection: 'row',
    alignItems: 'center',
    height: 30,
    marginHorizontal: spacing.sm,
    gap: 2,
    overflow: 'hidden',
  },
  // #257: width via flex (equal bars); height + colour are set inline per level.
  recWaveBar: {flex: 1, marginHorizontal: 0.5, borderRadius: 1.5},
  // #167: live char counter shown only for a mesh composer.
  charCount: {...type.caption, color: colors.textFaint},
  charCountOver: {color: colors.unread}, // #150: oversize for the radio
  link: {textDecorationLine: 'underline'}, // #262: tappable message links
  // #300: placeholder box for a Logos-Storage media blob while it loads / on error.
  mediaBox: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.card - 2,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  // #300: centered play badge over an inline (paused) video preview.
  playOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBadge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingLeft: 4, // optical-center the triangle
  },
  gifBtn: {...type.label, color: colors.textDim, fontWeight: '700', letterSpacing: 0.5},
  // #295: quoted-reply header atop a bubble.
  quoteBlock: {
    borderLeftWidth: 2,
    paddingLeft: spacing.sm,
    marginBottom: spacing.xs,
    opacity: 0.9,
  },
  quoteAuthor: {...type.caption, fontWeight: '600'},
  quoteSnippet: {...type.caption},
  // #295: composer reply banner.
  replyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.xs,
    backgroundColor: colors.panel,
    borderRadius: radii.card,
  },
  replyBannerBar: {width: 2, alignSelf: 'stretch', backgroundColor: colors.accent},
  replyBannerText: {flex: 1},
  replyBannerAuthor: {...type.caption, color: colors.accent, fontWeight: '600'},
  replyBannerSnippet: {...type.caption, color: colors.textDim},
  // #266 pinned-message bar
  pinBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.panel,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  pinBarPin: {fontSize: 14},
  pinBarText: {flex: 1, gap: 1},
  pinBarLabel: {...type.caption, color: colors.accent},
  pinBarMsg: {...type.label, color: colors.text},
  pinBarClear: {...type.title, color: colors.textDim, paddingHorizontal: spacing.xs},
  // #264 reaction strip
  // #299: bubble + its corner reactions share a relative box so the pills can be
  // absolutely anchored to overlap the bubble's lower corner.
  bubbleBox: {position: 'relative'},
  // #299: reaction pills anchored to the bubble's lower corner, overlapping the edge.
  reactStrip: {
    position: 'absolute',
    bottom: -11,
    flexDirection: 'row',
    gap: spacing.xs,
    zIndex: 2,
    elevation: 2,
  },
  reactStripOwn: {right: 8, justifyContent: 'flex-end'},
  reactStripPeer: {left: 8, justifyContent: 'flex-start'},
  // Reserve space below so the overhanging pills don't collide with the timestamp.
  timeRowReacted: {marginTop: 12},
  reactPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  reactPillMine: {borderColor: colors.accent, backgroundColor: '#2a1607'},
  reactEmoji: {fontSize: 10}, // #310: ~3/4 — the pills read as reactions, not full emoji
  reactCount: {...type.caption, color: colors.textDim},
  radioBudget: {
    ...type.caption,
    color: colors.textFaint,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xs,
  },
  send: {
    // #184: a perfect circle in every chat/group — fixed square + 50% radius, so
    // the icon/spinner inside never stretches it into a pill.
    backgroundColor: colors.accent,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
