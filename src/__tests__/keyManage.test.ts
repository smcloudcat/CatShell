import { describe, expect, it } from 'vitest'
import { createHostProfile, HostProfile } from '../types/host'
import { hostToConfigDraft, hostsToConfigDrafts, planConfigWrite } from '../utils/keyManage'

function makeHost(partial: Partial<HostProfile>): HostProfile {
  return createHostProfile({ name: 'web', host: 'web.example.com', username: 'alice', ...partial })
}

describe('hostToConfigDraft', () => {
  it('密钥认证主机投影出 IdentityFile', () => {
    const draft = hostToConfigDraft(
      makeHost({ authMethod: 'key', keyPath: 'C:/keys/id_ed25519', port: 2222 })
    )
    expect(draft).toEqual({
      name: 'web',
      hostname: 'web.example.com',
      port: 2222,
      user: 'alice',
      identityFile: 'C:/keys/id_ed25519'
    })
  })

  it('密码认证不落私钥路径，端口缺省 22', () => {
    const draft = hostToConfigDraft(makeHost({ authMethod: 'password', port: 0 }))
    expect(draft?.identityFile).toBeNull()
    expect(draft?.port).toBe(22)
  })

  it('agent / keyboard-interactive 同样不落私钥路径', () => {
    expect(hostToConfigDraft(makeHost({ authMethod: 'agent', keyPath: 'C:/keys/x' }))?.identityFile).toBeNull()
    expect(hostToConfigDraft(makeHost({ authMethod: 'keyboard-interactive' }))?.identityFile).toBeNull()
  })

  it('缺名称、缺地址或名称含空格时不可写回', () => {
    expect(hostToConfigDraft(makeHost({ name: '' }))).toBeNull()
    expect(hostToConfigDraft(makeHost({ host: '' }))).toBeNull()
    expect(hostToConfigDraft(makeHost({ name: 'bad name' }))).toBeNull()
  })

  it('名称与地址首尾空白被裁剪', () => {
    const draft = hostToConfigDraft(makeHost({ name: ' web ', host: ' h ', username: ' a ' }))
    expect(draft).toMatchObject({ name: 'web', hostname: 'h', user: 'a' })
  })
})

describe('hostsToConfigDrafts', () => {
  it('跳过不可写回的主机', () => {
    const drafts = hostsToConfigDrafts([
      makeHost({ name: 'a' }),
      makeHost({ name: '' }),
      makeHost({ name: 'b', host: 'b.example.com' })
    ])
    expect(drafts.map((draft) => draft.name)).toEqual(['a', 'b'])
  })
})

describe('planConfigWrite', () => {
  it('按大小写不敏感判定同名冲突', () => {
    const plan = planConfigWrite([makeHost({ name: 'Web' })], ['web'])
    expect(plan.conflicts).toEqual(['Web'])
    expect(plan.drafts).toHaveLength(1)
    expect(plan.skipped).toBe(0)
  })

  it('无冲突时为追加写入', () => {
    const plan = planConfigWrite([makeHost({ name: 'db' })], ['web'])
    expect(plan.conflicts).toEqual([])
    expect(plan.skipped).toBe(0)
  })

  it('不可写回的主机计入 skipped', () => {
    const plan = planConfigWrite([makeHost({ name: 'ok' }), makeHost({ name: '' })], [])
    expect(plan.skipped).toBe(1)
    expect(plan.drafts).toHaveLength(1)
  })
})
