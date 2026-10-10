/**
 * dsh-serial · HTTP 路由模块（面板与宿主之间的数据桥）
 *
 *   GET  /dsh-serial/api/ports          列出串口
 *   GET  /dsh-serial/api/status         服务状态
 *   GET  /dsh-serial/api/logs?since=N   增量取日志（面板轮询用）
 *   POST /dsh-serial/api/start  {port, baud, demo}
 *   POST /dsh-serial/api/stop
 *   POST /dsh-serial/api/send   {text}
 *
 * 为什么走 HTTP 而不是 ctx.remote：第三方插件的自定义 RPC 命名空间无法进入
 * 客户端装配（客户端不会在运行时发现宿主服务），会 pending 卡住整页。HTTP 路由
 * 是 dsh 官方给第三方插件的扩展点（ctx.webServer.register，dshmarket 同款）。
 *
 * 安全边界（自定义路由绕过 dsh /api 的围栏，安全自负）：
 *   1. Host 头防 DNS rebinding——仅当 Host 存在时校验；
 *   2. POST 同源校验防 CSRF——"有则校验、无则放行"：桌面版（Electron）代理转发
 *      时会剥离 origin/host 等头（社区实证 issue #648），若要求必带 Origin 会
 *      误伤桌面版所有写操作（dshmarket 有同样记录）；浏览器所有 POST 都会带
 *      Origin，缺失即说明不是网页客户端。带 Origin 时必须与 Host 一致，null/
 *      空串/跨站一律拒绝。
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = "/dsh-serial/api";
/** 回环地址的 Host（含 IPv6 环回 [::1]；大小写不敏感） */
const ALLOWED_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** 拒绝时留痕到临时目录（诊断用；成功路径不写文件） */
function logRejection(kind, req) {
  try {
    appendFileSync(
      join(tmpdir(), "dsh-serial-route-rejects.log"),
      JSON.stringify({
        t: new Date().toISOString(),
        kind,
        method: req.method,
        url: req.url,
        host: req.headers.host ?? null,
        origin: req.headers.origin ?? null,
        secFetchSite: req.headers["sec-fetch-site"] ?? null,
      }) + "\n"
    );
  } catch { /* 诊断失败不影响主流程 */ }
}

/** POST 同源校验（规则对齐 dshmarket 的 sameOrigin 实现，见文件头注释） */
function sameOriginOk(req) {
  if (req.headers["sec-fetch-site"] === "cross-site") {
    logRejection("cross-site", req);
    return false;
  }
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const host = req.headers.host;
  try {
    return host !== undefined && new URL(origin).host === host;
  } catch {
    logRejection("bad-origin", req);
    return false;
  }
}

/** 统一的 JSON 回复 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** 读取请求体（JSON），带大小上限 */
function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * 把串口服务的 HTTP 路由挂到 webServer 上。
 * @param {object} server - ctx.webServer 服务实例（dsh-host-webserver）
 * @param {object} service - SerialPortService
 * @returns {() => void} 卸载函数（cordis effect 调用它移除全部路由）
 */
export function mountSerialRoutes(server, service) {
  const disposers = [];

  /** 注册一个 exact 路由 + 统一的安全/解析/兜错外壳 */
  const route = (subpath, handler) => {
    disposers.push(
      server.register({
        kind: "exact",
        path: `${BASE}/${subpath}`,
        handler: async (req, res) => {
          try {
            // 安全 1：Host 头（防 DNS rebinding）——仅存在时校验：
            // 浏览器必发 Host；缺失要么不是网页、要么被桌面版代理剥离
            const host = req.headers.host;
            if (host !== undefined && !ALLOWED_HOST.test(host)) {
              logRejection("forbidden-host", req);
              return sendJson(res, 403, { ok: false, error: "forbidden host" });
            }
            // 安全 2：方法 + 同源（防 CSRF，兼容桌面版代理剥头）
            let body = {};
            if (req.method === "POST") {
              if (!sameOriginOk(req)) {
                return sendJson(res, 403, { ok: false, error: "same-origin POST required" });
              }
              body = await readBody(req);
            } else if (req.method !== "GET") {
              return sendJson(res, 405, { ok: false, error: "method not allowed" });
            }
            const url = new URL(req.url, "http://localhost");
            const query = Object.fromEntries(url.searchParams.entries());
            const result = await handler({ query, body });
            sendJson(res, 200, result);
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
          }
        },
      })
    );
  };

  route("ports", () => service.listPorts());
  route("status", () => service.status());
  route("start", ({ body }) =>
    service.start({
      port: body.port ? String(body.port) : undefined,
      baud: Number(body.baud) || 115200,
      demo: !!body.demo,
    })
  );
  route("stop", () => service.stop());
  route("logs", ({ query }) => service.readLogs({ since: Number(query.since) || 0 }));
  route("send", ({ body }) => service.send({ text: String(body.text || "").slice(0, 8192) }));

  return () => {
    for (const d of disposers) {
      try {
        d();
      } catch {}
    }
  };
}
