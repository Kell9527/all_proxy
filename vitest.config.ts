import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * 测试隔离：所有测试都必须写在临时目录里，绝不碰真实数据。
 *
 * ⚠️ 这里刻意**不**指向 `~/.dsh` 或仓库内的 `data/`：单测若污染真实账号
 * 或用量库，代价是用户要重新登录 10 个平台。需要自建目录的用例自行覆盖
 * `ALL_PROXY_DATA_DIR`。
 */
const dataDir = mkdtempSync(join(tmpdir(), 'all-proxy-test-'))

/**
 * Qoder 设备身份：测试里绝不能真的 spawn `runtime-info.exe`
 * （单次约 3.8 秒，且结果随开发机是否装了桌面端而变，会导致假失败）。
 * 指向不存在的路径即等价于「未安装」。
 */
const noSuchRuntimeInfo = join(dataDir, 'no-such-runtime-info')

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.spec.ts'],
    environment: 'node',
    env: {
      ALL_PROXY_DATA_DIR: dataDir,
      QODER_RUNTIME_INFO: noSuchRuntimeInfo,
    },
  },
})
