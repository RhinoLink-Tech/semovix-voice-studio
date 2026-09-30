/**
 * Profile 许可元数据（P1 #37）单元测试：四种来源的 kind/SPDX/再分发纪律
 */
import { describe, expect, it } from 'vitest';
import { buildProfileLicense, type ProfileLicenseInputs } from '../../server/lib/profileLicense';

function makeInputs(overrides: Partial<ProfileLicenseInputs> = {}): ProfileLicenseInputs {
  return {
    identity: { id: 'identity-1', name: '品牌主声' },
    profileName: '主声 V1',
    version: 'V1.0',
    sourceType: 'AI_DESIGNED',
    frozenAt: '2026-09-29T08:00:00.000Z',
    usageBoundaries: { allowed: ['品牌讲解'], prohibited: ['政治敏感'] },
    ...overrides,
  };
}

describe('buildProfileLicense', () => {
  it('AI 原创：kind=ai-original、可再分发、不携带授权摘要', () => {
    const license = buildProfileLicense(makeInputs());
    expect(license.license).toEqual({ kind: 'ai-original', spdxIdentifier: null, carriedFrom: null });
    expect(license.redistribution).toEqual({ allowed: true });
    expect(license.authorization).toBeUndefined();
    expect(license.includesOriginalReference).toBe(true);
    expect(license.watermark).toEqual({ applied: true, method: 'periodic-tone-v1' });
  });

  it('授权克隆：kind=consent-based、禁止再分发、授权摘要只含真实字段', () => {
    const license = buildProfileLicense(makeInputs({
      sourceType: '授权真人克隆',
      authorization: {
        subjectType: '本人',
        subjectName: '张三',
        relationship: '本人授权',
        confirmedBy: '李四',
        confirmedAt: '2026-09-01T00:00:00.000Z',
        validFrom: '2026-09-01',
        validUntil: '2027-09-01',
        document: { sha256: 'a'.repeat(64) },
      },
    }));
    expect(license.license.kind).toBe('consent-based');
    expect(license.redistribution).toEqual({ allowed: false });
    expect(license.authorization).toEqual({
      subjectType: '本人',
      subjectName: '张三',
      relationship: '本人授权',
      confirmedBy: '李四',
      confirmedAt: '2026-09-01T00:00:00.000Z',
      validFrom: '2026-09-01',
      validUntil: '2027-09-01',
      documentSha256: 'a'.repeat(64),
    });
  });

  it('授权摘要缺失字段如实留空，授权文件缺失时 documentSha256=null', () => {
    const license = buildProfileLicense(makeInputs({ sourceType: '授权真人克隆', authorization: { subjectName: '王五' } }));
    expect(license.authorization).toMatchObject({ subjectName: '王五', subjectType: '', documentSha256: null });
  });

  it('Provider 预置：kind=provider-terms、不可再分发、SPDX null（条款 ≠ SPDX 许可）', () => {
    const license = buildProfileLicense(makeInputs({ sourceType: 'Provider 预置音色' }));
    expect(license.license).toEqual({ kind: 'provider-terms', spdxIdentifier: null, carriedFrom: null });
    expect(license.redistribution).toEqual({ allowed: false });
  });

  it('导入包：carriedFrom 透传原包标识；未携带则 null', () => {
    const carried = buildProfileLicense(makeInputs({ sourceType: '导入已有 Voice Profile', importedSpdxIdentifier: 'Apache-2.0' }));
    expect(carried.license).toEqual({ kind: 'imported', spdxIdentifier: null, carriedFrom: 'Apache-2.0' });
    const bare = buildProfileLicense(makeInputs({ sourceType: '导入已有 Voice Profile' }));
    expect(bare.license.carriedFrom).toBeNull();
  });

  it('usageBoundaries 缺失回退空集；generatedAt 可注入固定值', () => {
    const license = buildProfileLicense(makeInputs({ usageBoundaries: null, generatedAt: '2026-09-29T09:00:00.000Z' }));
    expect(license.usageBoundaries).toEqual({ allowed: [], prohibited: [] });
    expect(license.generatedAt).toBe('2026-09-29T09:00:00.000Z');
  });

  it('无法识别的来源类型如实抛错，绝不猜类别', () => {
    expect(() => buildProfileLicense(makeInputs({ sourceType: 'MAGIC_SOURCE' }))).toThrow(/无法识别的 Profile 来源类型/);
  });
});
