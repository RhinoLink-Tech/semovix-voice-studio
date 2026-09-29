/**
 * Voice Profile 许可元数据（P1 #37，docs/001.md §37）
 *
 * 冻结与导出时固化的许可事实：许可标识、授权主体、授权有效期、允许/禁止
 * 用途、可否再分发、是否含原始参考音频、预览水印。核心纪律——
 *
 *  1. SPDX 纪律：只有「经过验证的真实许可」才配 spdxIdentifier。本应用内
 *     产生的三种原创/授权/条款来源都没有可核验的 SPDX 标识，一律 null；
 *     唯一例外是导入包原 manifest 携带的标识（carriedFrom 透传，不背书）。
 *  2. AI 原创绝不伪装成“本人授权声音”：kind 如实标注 ai-original，
 *     不携带 authorization 摘要。
 *  3. 授权摘要只记录授权记录里真实存在的字段，绝不补造。
 */

export type ProfileLicenseKind = 'consent-based' | 'provider-terms' | 'imported' | 'ai-original';

/** 克隆授权摘要：只带元数据，绝不带授权文件本体（PDF 留在冻结目录内） */
export interface ProfileAuthorizationSummary {
  subjectType: string;
  subjectName: string;
  relationship: string;
  confirmedBy: string;
  confirmedAt: string;
  validFrom: string;
  validUntil: string;
  documentSha256: string | null;
}

export interface ProfileLicense {
  schemaVersion: 1;
  identity: { id: string; name: string };
  profileName: string;
  version: string;
  sourceType: string;
  frozenAt: string;
  generatedAt: string;
  license: { kind: ProfileLicenseKind; spdxIdentifier: string | null; carriedFrom: string | null };
  /** 仅 consent-based（授权真人克隆）存在 */
  authorization?: ProfileAuthorizationSummary;
  usageBoundaries: { allowed: string[]; prohibited: string[] };
  /** AI 原创可再分发；授权/条款/导入来源一律保守禁止（未获再分发授权） */
  redistribution: { allowed: boolean };
  /** 包内含 reference.wav（事实陈述，供接收方判断处置方式） */
  includesOriginalReference: boolean;
  /** 预览音频一律加水印（#36 导出时施加 periodic-tone-v1） */
  watermark: { applied: true; method: 'periodic-tone-v1' };
}

/** 授权记录的宽松形状（voiceClone.ts CloneAuthorization 的子集读取） */
export type AuthorizationRecord = Partial<Record<keyof ProfileAuthorizationSummary, unknown>> & {
  document?: { sha256?: unknown } | null;
};

export interface ProfileLicenseInputs {
  identity: { id: string; name: string };
  profileName: string;
  version: string;
  sourceType: string;
  frozenAt: string;
  /** 优先发布决策/请求体；缺失回退 manifest.usageBoundaries，再退空集 */
  usageBoundaries: { allowed: string[]; prohibited: string[] } | null;
  /** 克隆路线的 authorization.json 内容 */
  authorization?: AuthorizationRecord | null;
  /** 导入包携带的许可标识（#36 起入档） */
  importedSpdxIdentifier?: string | null;
  generatedAt?: string;
}

const KIND_BY_SOURCE: Record<string, ProfileLicenseKind> = {
  AI_DESIGNED: 'ai-original',
  '授权真人克隆': 'consent-based',
  'Provider 预置音色': 'provider-terms',
  '导入已有 Voice Profile': 'imported',
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function buildProfileLicense(inputs: ProfileLicenseInputs): ProfileLicense {
  const kind = KIND_BY_SOURCE[inputs.sourceType];
  // 许可元数据被错误分类比缺一份导出更糟：无法识别的来源如实失败，绝不猜类别
  if (!kind) throw new Error(`无法识别的 Profile 来源类型，拒绝生成许可元数据：${inputs.sourceType}`);

  const license: ProfileLicense = {
    schemaVersion: 1,
    identity: inputs.identity,
    profileName: inputs.profileName,
    version: inputs.version,
    sourceType: inputs.sourceType,
    frozenAt: inputs.frozenAt,
    generatedAt: inputs.generatedAt ?? new Date().toISOString(),
    license: {
      kind,
      spdxIdentifier: null,
      carriedFrom: kind === 'imported' ? inputs.importedSpdxIdentifier ?? null : null,
    },
    usageBoundaries: inputs.usageBoundaries ?? { allowed: [], prohibited: [] },
    redistribution: { allowed: kind === 'ai-original' },
    includesOriginalReference: true,
    watermark: { applied: true, method: 'periodic-tone-v1' },
  };

  if (kind === 'consent-based' && inputs.authorization) {
    const record = inputs.authorization;
    license.authorization = {
      subjectType: text(record.subjectType),
      subjectName: text(record.subjectName),
      relationship: text(record.relationship),
      confirmedBy: text(record.confirmedBy),
      confirmedAt: text(record.confirmedAt),
      validFrom: text(record.validFrom),
      validUntil: text(record.validUntil),
      documentSha256: typeof record.document?.sha256 === 'string' ? record.document.sha256 : null,
    };
  }
  return license;
}
