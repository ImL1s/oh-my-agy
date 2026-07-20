/**
 * 設計概念映射：Team v1 worker hold 程序（對齊 OMC team worker bootstrap 的「佔住 pane」最小子集）。
 * 僅維持 tmux pane 存活並寫入 ready marker；不啟動 agy（後續 plan）。
 *
 * argv（由 TmuxController.startWorker 組裝）:
 *   process.argv[2] = markerPath（必要）
 *   process.argv[3] = descriptorPath（可選，由 controller 附加）
 */
import * as fs from 'fs';

const markerPath = process.argv[2];
if (!markerPath || markerPath.includes('\0')) {
  process.stderr.write('worker-hold: marker path required\n');
  process.exit(2);
}

try {
  fs.writeFileSync(markerPath, 'ready\n', 'utf8');
} catch (error) {
  process.stderr.write(`worker-hold: cannot write marker: ${
    error instanceof Error ? error.message : String(error)
  }\n`);
  process.exit(1);
}

// 維持 process 存活，讓 tmux pane 不立即退出
setInterval(() => {}, 60_000);
