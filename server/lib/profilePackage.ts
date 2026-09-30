/**
 * 可移植 Voice Profile 包（P1 #36，docs/001.md §36）
 *
 * `.semovix` 语义的 ZIP 包：接收方（另一台 Semovix 或合规审核方）拿到的是
 * 自描述的完整事实——manifest（未改动，sidecar 校验天然通过）、参考音频、
 * 验证报告、许可元数据（#37）、来源证据、加水印的 preview（#37 水印）。
 *
 * 往返闭环：导出包的 manifest.json 与冻结目录逐字节一致，既有导入校验
 * （voiceAdditionalSources.loadImportedProfile）无需任何放宽即可导入。
 */
import crypto from 'crypto';
import JSZip from 'jszip';
import type { ProfileLicense } from './profileLicense';
import { applyPreviewWatermark } from './audioWatermark';
import type { PublishedProfileManifest } from './profileManifest';

export interface PortablePackageInput {
  /** 冻结 manifest 解析值（供来源证据提取） */
  manifest: PublishedProfileManifest;
  /** 冻结 manifest.json 原始字节（逐字节入包，保证 manifest.sha256 继续有效） */
  manifestContent: Buffer;
  referenceWav: Buffer;
  validationReport: Buffer | null;
  license: ProfileLicense;
}

/**
 * 来源证据：按来源类型提取「这份声音从哪来」的可追溯摘要。
 * 全部取自冻结 manifest 里已有的事实，绝不补造；缺失字段如实 null。
 */
export function buildSourceEvidence(manifest: PublishedProfileManifest, license: ProfileLicense): Record<string, unknown> {
  const sourceType = manifest.identity?.sourceType;
  const asset = (manifest.source?.asset ?? {}) as Record<string, unknown>;
  if (sourceType === 'AI_DESIGNED') {
    return {
      schemaVersion: 1,
      kind: 'ai-designed',
      designBatch: manifest.designBatch ?? null,
      review: manifest.review ?? null,
      validation: manifest.validation ?? null,
    };
  }
  if (sourceType === '授权真人克隆') {
    return {
      schemaVersion: 1,
      kind: 'authorized-clone',
      authorization: license.authorization ?? null,
      referenceAudioSha256: manifest.referenceAudio?.sha256 ?? null,
      authorizationDocumentSha256: typeof asset.authorizationSha256 === 'string' ? asset.authorizationSha256 : null,
      validFrom: typeof asset.validFrom === 'string' ? asset.validFrom : null,
      validUntil: typeof asset.validUntil === 'string' ? asset.validUntil : null,
    };
  }
  if (sourceType === 'Provider 预置音色') {
    return {
      schemaVersion: 1,
      kind: 'provider-preset',
      provider: typeof asset.provider === 'string' ? asset.provider : null,
      speaker: typeof asset.speaker === 'string' ? asset.speaker : null,
      productionModel: manifest.productionModel ?? null,
      previewSha256: typeof asset.previewSha256 === 'string' ? asset.previewSha256 : null,
    };
  }
  // 导入来源（透传链）：原包标识原样带出，供下游继续追溯
  return {
    schemaVersion: 1,
    kind: 'imported',
    originalSourceType: typeof asset.originalSourceType === 'string' ? asset.originalSourceType : null,
    originalName: typeof asset.originalName === 'string' ? asset.originalName : null,
    packageSha256: typeof asset.packageSha256 === 'string' ? asset.packageSha256 : null,
    manifestSha256: typeof asset.manifestSha256 === 'string' ? asset.manifestSha256 : null,
    referenceSha256: typeof asset.referenceSha256 === 'string' ? asset.referenceSha256 : null,
    carriedFromSpdx: license.license.carriedFrom,
  };
}

export interface PortablePackage {
  buffer: Buffer;
  entries: string[];
}

/**
 * 构建可移植包。preview.wav = reference.wav 加 periodic-tone-v1 水印副本
 * （#37）；参考音频非 16-bit PCM 时 applyPreviewWatermark 抛
 * watermark_unsupported_format，导出如实失败——绝不静默产出无水印预览。
 */
export async function buildPortablePackage(input: PortablePackageInput): Promise<PortablePackage> {
  const zip = new JSZip();
  const manifestContent = input.manifestContent;
  zip.file('manifest.json', manifestContent);
  zip.file('manifest.sha256', `${crypto.createHash('sha256').update(manifestContent).digest('hex')}  manifest.json\n`);
  zip.file('reference.wav', input.referenceWav);
  if (input.validationReport) zip.file('validation-report.json', input.validationReport);
  zip.file('license.json', `${JSON.stringify(input.license, null, 2)}\n`);
  zip.file('source-evidence.json', `${JSON.stringify(buildSourceEvidence(input.manifest, input.license), null, 2)}\n`);
  zip.file('preview.wav', applyPreviewWatermark(input.referenceWav));
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  return { buffer, entries: Object.keys(zip.files).sort() };
}
