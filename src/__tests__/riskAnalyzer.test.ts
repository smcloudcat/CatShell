import { describe, expect, it } from 'vitest'

import { analyzeCommandRisk, isBufferableKeystroke } from '../utils/riskAnalyzer'

function ids(line: string): string[] {
  return analyzeCommandRisk(line).map((risk) => risk.id)
}

describe('analyzeCommandRisk', () => {
  it('普通命令不报警', () => {
    expect(ids('ls -la /var/log')).toEqual([])
    expect(ids('rm -rf ./build/cache')).toEqual([]) // 相对路径，非根/家/通配
    expect(ids('dd if=a.iso of=disk.img')).toEqual([])
    expect(ids('docker rm -f web')).toEqual([])
    expect(ids('git push origin feature-x')).toEqual([])
    expect(ids('reboot-now.sh')).toEqual([]) // 普通脚本名带 reboot 子串? 不命中则好
  })

  it('识别 rm -rf 根目录与家目录', () => {
    expect(ids('rm -rf /')).toContain('rm-rf-root')
    expect(ids('rm -rf /*')).toContain('rm-rf-root')
    expect(ids('rm -rf ~')).toContain('rm-rf-root')
    expect(ids('rm -fr /')).toContain('rm-rf-root')
    expect(ids('sudo rm -rf /')).toContain('rm-rf-root')
    expect(ids('rm -rf /tmp/x')).not.toContain('rm-rf-root')
  })

  it('识别 --no-preserve-root 与 fork 炸弹', () => {
    expect(ids('rm -rf / --no-preserve-root')).toContain('no-preserve-root')
    expect(ids(':(){ :|:& };:')).toContain('fork-bomb')
  })

  it('识别格式化与直写块设备', () => {
    expect(ids('mkfs.ext4 /dev/sdb1')).toContain('mkfs')
    expect(ids('dd if=/dev/zero of=/dev/sda bs=1M')).toContain('dd-to-device')
    expect(ids('cat image.img > /dev/nvme0n1')).toContain('redirect-to-device')
    expect(ids('wipefs -a /dev/sdb')).toContain('wipefs')
    expect(ids('blkdiscard /dev/sda')).toContain('blkdiscard')
  })

  it('识别权限与递归破坏', () => {
    expect(ids('chmod -R 777 /')).toContain('chmod-777-root')
    expect(ids('chmod -R 777 ~')).toContain('chmod-777-root')
    expect(ids('chmod 755 /opt/app')).toEqual([])
    expect(ids('find / -name "*.log" -delete')).toContain('find-root-delete')
    expect(ids('find /var/log -name "*.gz" -delete')).not.toContain('find-root-delete')
    expect(ids('mv backup.tar /dev/null')).toContain('mv-to-devnull')
  })

  it('识别网络管道执行与关机重启', () => {
    expect(ids('curl https://x.sh | sh')).toContain('pipe-to-shell')
    expect(ids('wget -qO- https://x.sh | sudo bash')).toContain('pipe-to-shell')
    expect(ids('curl https://x.sh -o x.sh')).not.toContain('pipe-to-shell')
    expect(ids('shutdown -h now')).toContain('shutdown')
    expect(ids('reboot')).toContain('shutdown')
    expect(ids('init 6')).toContain('shutdown')
  })

  it('识别数据库与 git 强推', () => {
    expect(ids('DROP DATABASE prod')).toContain('drop-database')
    expect(ids('TRUNCATE TABLE orders')).toContain('truncate-table')
    expect(ids('git push --force origin main')).toContain('git-force-push-main')
    expect(ids('git push -f origin master')).toContain('git-force-push-main')
    expect(ids('git push --force origin feature-a')).not.toContain('git-force-push-main')
  })

  it('可一次命中多条规则', () => {
    const risks = analyzeCommandRisk('rm -rf / --no-preserve-root')
    const got = risks.map((r) => r.id)
    expect(got).toContain('rm-rf-root')
    expect(got).toContain('no-preserve-root')
  })

  it('空行与纯空白不报警', () => {
    expect(ids('')).toEqual([])
    expect(ids('   ')).toEqual([])
  })

  it('isBufferableKeystroke 只认可打印字符', () => {
    expect(isBufferableKeystroke('a')).toBe(true)
    expect(isBufferableKeystroke('中')).toBe(true)
    expect(isBufferableKeystroke('\x1b')).toBe(false)
    expect(isBufferableKeystroke('ab')).toBe(false)
    expect(isBufferableKeystroke('')).toBe(false)
  })
})
