import { spawn } from "child_process";
import type { GuideResult } from "./reading-guide";

declare const __LOCAL_IR_GUIDE_WORKER__: string;

export function startGuideJob(input: Record<string, unknown>) {
  const child = spawn("node", ["--input-type=module", "-e", __LOCAL_IR_GUIDE_WORKER__], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LOCAL_IR_GUIDE_WORKER: "1" }
  });
  let cancel: () => void = () => child.kill();
  const result = new Promise<GuideResult>((resolve, reject) => {
    let output = "", settled = false;
    const finish = (error?: Error, value?: GuideResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error("导读卡生成超过 15 分钟，已停止；原文件未改动。")), 15 * 60 * 1000);
    cancel = () => finish(new Error("导读卡生成已取消，原文件未改动。"));
    child.on("error", () => finish(new Error("无法启动本地 Node，请检查标准预处理运行环境。")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.length > 16 * 1024 * 1024) finish(new Error("导读卡响应过大，原文件未改动。"));
    });
    child.stderr.resume(); // Audit files, not private provider payloads in the Obsidian console.
    child.stdin.on("error", () => finish(new Error("导读卡处理进程已停止，原文件未改动。")));
    child.on("close", code => {
      try {
        const response = JSON.parse(output);
        if (code !== 0 || !response.ok) finish(new Error(`导读卡生成失败（${response.error || "worker_failed"}），原文件未改动。`));
        else finish(undefined, response.result);
      } catch { finish(new Error("导读卡处理未返回有效结果，原文件未改动。")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
  return { result, cancel: () => cancel() };
}
