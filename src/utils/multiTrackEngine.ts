import { MultiTrack, TimelineClip, MasteringPreset } from '../types/audio';
import { audioBufferToWav } from './audioEngine';

// 母带预设：当前渲染链执行 EQ、压缩与峰值归一化；targetLufs 为保留字段（未来响度能力），
// 尚未实现 BS.1770 / EBU R128 的 Integrated LUFS 与 True Peak 测量闭环，不得对外表述为已达响度标准。
export const MASTERING_PRESETS: MasteringPreset[] = [
  {
    id: 'podcast_broadcast',
    name: '播客人声预设',
    targetLufs: -16,
    description: '突出人声通透度与中频厚度，抑制爆音，适合播客与访谈类内容的人声听感。',
    eqBoostLow: 1.5,
    eqBoostHigh: 2.0,
    compressionRatio: 3.0,
  },
  {
    id: 'social_video',
    name: '短视频高响度预设',
    targetLufs: -14,
    description: '更饱满有力的听感，在手机扬声器下声音依然清晰、穿透力强，适合短视频与社交媒体内容。',
    eqBoostLow: 2.5,
    eqBoostHigh: 3.5,
    compressionRatio: 4.5,
  },
  {
    id: 'cinematic_epic',
    name: '影视动态预设',
    targetLufs: -18,
    description: '保留宽广动态范围 (Wide Dynamic Range)，低音深沉、高音泛音空灵。',
    eqBoostLow: 3.0,
    eqBoostHigh: 2.0,
    compressionRatio: 2.0,
  },
  {
    id: 'transparent_natural',
    name: '原声直通预设',
    targetLufs: -16,
    description: '不额外增加染色与压限，保证各轨道最忠实的原始质感。',
    eqBoostLow: 0,
    eqBoostHigh: 0,
    compressionRatio: 1.5,
  },
];

// Cache decoded audio buffers for fast timeline rendering
const bufferCache = new Map<string, AudioBuffer>();

export async function fetchAndDecodeAudio(url: string, audioCtx: AudioContext | OfflineAudioContext): Promise<AudioBuffer> {
  if (bufferCache.has(url)) {
    return bufferCache.get(url)!;
  }
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  // Using decodeAudioData clone if using offline audio context
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  bufferCache.set(url, decoded);
  return decoded;
}

export interface RenderMultiTrackOptions {
  tracks: MultiTrack[];
  masterVolume?: number; // 0 to 1.5
  preset?: MasteringPreset;
  enableAutoDucking?: boolean; // automatically dip music/sfx when voice track speaks
  duckingAmount?: number; // 0.2 to 0.6 (how quiet BGM becomes)
  onProgress?: (progress: number) => void;
}

/**
 * Calculates total project duration based on clips
 */
export function calculateTimelineDuration(tracks: MultiTrack[]): number {
  let maxEnd = 0;
  for (const t of tracks) {
    for (const c of t.clips) {
      const end = c.startTime + c.duration;
      if (end > maxEnd) maxEnd = end;
    }
  }
  return Math.max(5, maxEnd + 1.0); // minimum 5s, 1s tail
}

/**
 * High-performance Offline Multi-Track Mixdown and Mastering Engine
 */
export async function renderMultiTrackMixdown(
  options: RenderMultiTrackOptions
): Promise<{ audioUrl: string; duration: number; buffer: AudioBuffer }> {
  const {
    tracks,
    masterVolume = 1.0,
    preset = MASTERING_PRESETS[0],
    enableAutoDucking = false,
    duckingAmount = 0.35,
    onProgress,
  } = options;

  const totalDuration = calculateTimelineDuration(tracks);
  const sampleRate = 44100;
  const lengthInFrames = Math.ceil(totalDuration * sampleRate);

  // Initialize Offline Context
  const offlineCtx = new OfflineAudioContext(2, lengthInFrames, sampleRate);

  // Pre-load all audio buffers
  const uniqueUrls = new Set<string>();
  tracks.forEach((t) => t.clips.forEach((c) => uniqueUrls.add(c.audioUrl)));

  let loadedCount = 0;
  const totalUrls = uniqueUrls.size;

  const loadedBuffers = new Map<string, AudioBuffer>();
  for (const url of uniqueUrls) {
    try {
      const buf = await fetchAndDecodeAudio(url, offlineCtx);
      loadedBuffers.set(url, buf);
    } catch (e) {
      console.warn(`Could not load audio url: ${url}`, e);
    }
    loadedCount++;
    if (onProgress) {
      onProgress((loadedCount / (totalUrls || 1)) * 0.4);
    }
  }

  // Find voice intervals for auto-ducking
  const voiceIntervals: Array<{ start: number; end: number }> = [];
  if (enableAutoDucking) {
    const voiceTracks = tracks.filter((t) => t.type === 'voice' && !t.muted);
    for (const vt of voiceTracks) {
      for (const clip of vt.clips) {
        if (!clip.muted) {
          voiceIntervals.push({
            start: Math.max(0, clip.startTime - 0.1),
            end: clip.startTime + clip.duration + 0.3,
          });
        }
      }
    }
  }

  // Master bus
  const masterBus = offlineCtx.createGain();
  masterBus.gain.value = masterVolume;

  // Mastering EQ - Low
  const masterLowEq = offlineCtx.createBiquadFilter();
  masterLowEq.type = 'lowshelf';
  masterLowEq.frequency.value = 250;
  masterLowEq.gain.value = preset.eqBoostLow;

  // Mastering EQ - High
  const masterHighEq = offlineCtx.createBiquadFilter();
  masterHighEq.type = 'highshelf';
  masterHighEq.frequency.value = 4500;
  masterHighEq.gain.value = preset.eqBoostHigh;

  // Mastering Dynamics Compressor
  const compressor = offlineCtx.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 12;
  compressor.ratio.value = preset.compressionRatio;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  // Route: MasterBus -> LowEq -> HighEq -> Compressor -> Destination
  masterBus.connect(masterLowEq);
  masterLowEq.connect(masterHighEq);
  masterHighEq.connect(compressor);
  compressor.connect(offlineCtx.destination);

  // Check solo state
  const hasSolo = tracks.some((t) => t.solo);

  // Schedule each track and clip
  for (const track of tracks) {
    if (track.muted) continue;
    if (hasSolo && !track.solo) continue;

    // Track gain & pan
    const trackGain = offlineCtx.createGain();
    trackGain.gain.value = track.volume;

    const panner = offlineCtx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, track.pan));

    trackGain.connect(panner);
    panner.connect(masterBus);

    // Apply auto ducking to non-voice tracks
    if (enableAutoDucking && track.type !== 'voice' && voiceIntervals.length > 0) {
      for (const interval of voiceIntervals) {
        // Smoothly ramp down
        trackGain.gain.setValueAtTime(track.volume, Math.max(0, interval.start - 0.2));
        trackGain.gain.linearRampToValueAtTime(track.volume * duckingAmount, interval.start);
        trackGain.gain.setValueAtTime(track.volume * duckingAmount, interval.end);
        trackGain.gain.linearRampToValueAtTime(track.volume, interval.end + 0.3);
      }
    }

    // Schedule clips in this track
    for (const clip of track.clips) {
      if (clip.muted) continue;
      const buffer = loadedBuffers.get(clip.audioUrl);
      if (!buffer) continue;

      const clipSource = offlineCtx.createBufferSource();
      clipSource.buffer = buffer;

      const clipGain = offlineCtx.createGain();
      clipGain.gain.value = clip.volume;

      clipSource.connect(clipGain);
      clipGain.connect(trackGain);

      // Start buffer playback
      const clipStart = Math.max(0, clip.startTime);
      const clipOffset = Math.max(0, clip.offset || 0);
      const clipDuration = Math.min(clip.duration, buffer.duration - clipOffset);

      if (clipDuration > 0) {
        clipSource.start(clipStart, clipOffset, clipDuration);
      }
    }
  }

  if (onProgress) onProgress(0.7);

  // Render the audio graph
  const renderedBuffer = await offlineCtx.startRendering();

  if (onProgress) onProgress(0.9);

  // Normalization pass
  let maxPeak = 0;
  for (let c = 0; c < renderedBuffer.numberOfChannels; c++) {
    const data = renderedBuffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const val = Math.abs(data[i]);
      if (val > maxPeak) maxPeak = val;
    }
  }

  if (maxPeak > 0.001) {
    const norm = 0.96 / maxPeak;
    for (let c = 0; c < renderedBuffer.numberOfChannels; c++) {
      const data = renderedBuffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        data[i] *= norm;
      }
    }
  }

  const wavBlob = audioBufferToWav(renderedBuffer);
  const audioUrl = URL.createObjectURL(wavBlob);

  if (onProgress) onProgress(1.0);

  return {
    audioUrl,
    duration: totalDuration,
    buffer: renderedBuffer,
  };
}
