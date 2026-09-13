#!/usr/bin/env node

// ====================== Argo + TUIC 变量设置区域 开始 ======================

const TUIC_PORT = process.env.TUIC_PORT || "6707";                       // TUIC 端口 （留空=不部署）

const ARGO_PORT = process.env.ARGO_PORT || "8001";                       // Argo回源端口填入8001 （留空=不部署）

const ARGO_PROTOCOL = process.env.ARGO_PROTOCOL || "quic";           // http2或quic （http2=稳定+低占用；quic=响应快+占用略高）

const ARGO_CONNECTIONS = process.env.ARGO_CONNECTIONS || "1";        // 隧道连接数量 建议http2=4，quic=1 （多条UDP可能会触发机房QoS）

const ARGO_DOMAIN = process.env.ARGO_DOMAIN || "";                   // 固定隧道域名

const ARGO_AUTH = process.env.ARGO_AUTH || "";                       // 固定隧道 Token

const CFIP = process.env.CFIP || "www.wto.org";                      // 优选域名/IP （www.visa.com.hk  usa.visa.com  www.shopify.com) 

const WEB_PORT = process.env.WEB_PORT || process.env.SERVER_PORT || "80"; // 面板开放给外网访问 sub.txt 的 HTTP 端口

// ====================== Argo + TUIC 变量设置区域 完成 ======================

const http = require("http");
const https = require("https");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");

const SERVER_IP_ENV = process.env.SERVER_IP || "";                   // 手动指定的服务器公网IP/域名
const CFPORT = process.env.CFPORT || 443;                            // 端口
const NAME = process.env.NAME || "easyshare";                

const FILE_PATH = process.env.FILE_PATH || ".tmp";
const URL_FILE_PATH = process.env.URL_FILE_PATH || "sub.txt"; 
const CACHE_FILE_PATH = path.join(FILE_PATH, "config_cache.json");

const GO_BASE_ENV = {
  ...process.env,
  GODEBUG: "madvdontneed=1,cgocheck=0",
  GOMAXPROCS: "1",
  GOGC: "10"
};

const log = (msg) => process.stdout.write(msg + "\n");

if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

// ==================== 读取与持久化 UUID 及 TUIC 密码 ====================
let cacheData = {};
if (fs.existsSync(CACHE_FILE_PATH)) {
  try {
    cacheData = JSON.parse(fs.readFileSync(CACHE_FILE_PATH, "utf-8"));
  } catch (e) {
    cacheData = {};
  }
}

// 1. 优先读取环境变量 -> 次之读取本地缓存文件 -> 最后自动生成新 UUID
let rawUUID = process.env.UUID || cacheData.UUID;
if (!rawUUID) {
  rawUUID = (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  }));
}
const UUID = rawUUID.toLowerCase();

// 2. 优先读取环境变量 -> 次之读取本地缓存文件 -> 最后自动生成 32位复杂 TUIC 密码
let TUIC_PASS = process.env.TUIC_PASS || cacheData.TUIC_PASS;
if (!TUIC_PASS) {
  TUIC_PASS = crypto.randomBytes(16).toString("hex");
}

// 3. 将配置保存至本地缓存文件
try {
  fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify({ UUID, TUIC_PASS }, null, 2), "utf-8");
} catch (e) {
  log(`[警告] 缓存配置写入失败: ${e.message}`);
}

const SHORT_UUID = UUID.split("-")[0] || UUID.substring(0, 8);
const WS_PATH = `/${UUID}-vless`;

// 自动获取公网 IP 函数
function getPublicIP() {
  return new Promise((resolve) => {
    if (SERVER_IP_ENV.trim() !== "") return resolve(SERVER_IP_ENV.trim());
    https.get("https://api.ipify.org", (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data.trim() || "127.0.0.1"));
    }).on("error", () => resolve("127.0.0.1"));
  });
}

function downloadFile(urlStr, targetPath) {
  return new Promise((resolve, reject) => {
    const client = urlStr.startsWith("https") ? https : http;
    const req = client.get(urlStr, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        req.destroy();
        return downloadFile(res.headers.location, targetPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`HTTP 状态码异常: ${res.statusCode}`));
      }
      if (!fs.existsSync(path.dirname(targetPath))) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      }
      const file = fs.createWriteStream(targetPath);
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          req.destroy();
          resolve();
        });
      });
    });
    req.on("error", (err) => {
      req.destroy();
      try { fs.unlinkSync(targetPath); } catch (e) {}
      reject(err);
    });
  });
}

function extractSingbox(tarPath, targetWebPath) {
  try {
    execSync(`tar -xzf "${tarPath}" -C "${FILE_PATH}" --wildcards "*/sing-box" --strip-components=1 || tar -xzf "${tarPath}" -C "${FILE_PATH}" sing-box`);
    const extractedPath = path.join(FILE_PATH, "sing-box");
    if (fs.existsSync(extractedPath)) {
      if (extractedPath !== targetWebPath) fs.renameSync(extractedPath, targetWebPath);
      return;
    }
  } catch (e) {}
  throw new Error("提取 sing-box 失败");
}

function generateSelfSignedCert(certPath, keyPath) {
  try {
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return;
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 3650 -subj "/CN=bing.com"`, { stdio: "ignore" });
  } catch (e) {
    log("[提示] 系统的 openssl 未就绪，正在生成 TLS 证书密钥...");
  }
}

const webPath = path.join(FILE_PATH, "web");
const botPath = path.join(FILE_PATH, "bot");
const bootLogPath = path.join(FILE_PATH, "boot.log");
const configPath = path.join(FILE_PATH, "config.json");
const certPath = path.join(FILE_PATH, "cert.pem");
const keyPath = path.join(FILE_PATH, "key.pem");

async function main() {
  try { execSync("pkill -9 -f sing-box", { stdio: "ignore" }); } catch (e) {}
  try { execSync("pkill -9 -f cloudflared", { stdio: "ignore" }); } catch (e) {}
  try { execSync("rm -rf /tmp/*", { stdio: "ignore" }); } catch (e) {}
  await new Promise((r) => setTimeout(r, 1000)); 
  log("[环境重置] 历史进程与临时文件已清理");

  if (fs.existsSync(bootLogPath)) {
    try { fs.unlinkSync(bootLogPath); } catch (e) {}
  }

  const serverIP = await getPublicIP();
  const inbounds = [];

  // 配置 Argo (VLESS)
  if (ARGO_PORT.trim() !== "") {
    inbounds.push({
      type: "vless",
      tag: "vless-in",
      listen: "127.0.0.1",
      listen_port: parseInt(ARGO_PORT),
      users: [{ uuid: UUID }],
      transport: {
        type: "ws",
        path: WS_PATH
      }
    });
  }

  // 配置 TUIC
  if (TUIC_PORT.trim() !== "") {
    generateSelfSignedCert(certPath, keyPath);
    inbounds.push({
      type: "tuic",
      tag: "tuic-in",
      listen: "::",
      listen_port: parseInt(TUIC_PORT),
      users: [
        {
          uuid: UUID,
          password: TUIC_PASS
        }
      ],
      congestion_control: "bbr",
      tls: {
        enabled: true,
        alpn: ["h3"],
        certificate_path: certPath,
        key_path: keyPath
      }
    });
  }

  if (inbounds.length === 0) {
    throw new Error("TUIC_PORT 与 ARGO_PORT 均为留空状态，未启用任何服务！");
  }

  const config = {
    log: { level: "panic" },
    inbounds: inbounds,
    outbounds: [{ 
      type: "direct", 
      tag: "direct",
      udp_fragment: true
    }]
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const isArm = ["arm", "arm64", "aarch64"].includes(os.arch());
  const cloudflaredUrl = isArm
    ? "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
    : "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";

  const SINGBOX_VER = "1.11.4";
  const singboxTarUrl = isArm
    ? `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VER}/sing-box-${SINGBOX_VER}-linux-arm64.tar.gz`
    : `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VER}/sing-box-${SINGBOX_VER}-linux-amd64.tar.gz`;

  if (!fs.existsSync(webPath)) {
    log("正在下载 sing-box...");
    const tempTar = path.join(FILE_PATH, "singbox.tar.gz");
    await downloadFile(singboxTarUrl, tempTar);
    extractSingbox(tempTar, webPath);
    try { fs.unlinkSync(tempTar); } catch (e) {}
  }

  if (ARGO_PORT.trim() !== "" && !fs.existsSync(botPath)) {
    log("正在下载 Cloudflared...");
    await downloadFile(cloudflaredUrl, botPath);
  }

  fs.chmodSync(webPath, 0o775);
  if (fs.existsSync(botPath)) fs.chmodSync(botPath, 0o775);

  log("正在启动 sing-box 服务...");
  let webProc = spawn(webPath, ["run", "-c", configPath], {
    env: Object.assign({}, GO_BASE_ENV, { 
      GOMAXPROCS: "1",
      GOGC: "10",              
      GOMEMLIMIT: "7MiB"       
    }),
    stdio: "ignore",
    detached: true 
  });
  webProc.unref();

  await new Promise((r) => setTimeout(r, 1000));

  let domain = ARGO_DOMAIN.trim();
  const authTrim = ARGO_AUTH.trim();

  if (ARGO_PORT.trim() !== "") {
    let argoArgs = [
      "tunnel",
      "--no-autoupdate",
      "--protocol", ARGO_PROTOCOL.toLowerCase(),
      "--ha-connections", String(ARGO_CONNECTIONS)
    ];

    if (authTrim.length > 30) {
      log(`检测到 Token，启动固定隧道 [协议:${ARGO_PROTOCOL} | 连接数:${ARGO_CONNECTIONS}]...`);
      argoArgs.push("run", "--token", authTrim);
      if (!domain) {
        domain = "your-argo-domain.com";
      }
    } else {
      log(`未检测到 Token，启动临时隧道...`);
      argoArgs.push("--url", `http://127.0.0.1:${ARGO_PORT}`, "--logfile", bootLogPath, "--loglevel", "info");
    }

    log("正在启动 Cloudflared 隧道...");
    let botProc = spawn(botPath, argoArgs, {
      env: Object.assign({}, GO_BASE_ENV, { GOMEMLIMIT: "14MiB" }),
      stdio: "ignore",
      detached: true 
    });
    botProc.unref();

    if (!domain && authTrim.length <= 30) {
      log("正在获取 Argo 临时域名...");
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (fs.existsSync(bootLogPath)) {
          try {
            const logText = fs.readFileSync(bootLogPath, "utf-8");
            if (logText && logText.length > 0) {
              const match = logText.match(/https?:\/\/([^ ]*trycloudflare\.com)\/?/);
              if (match) {
                domain = match[1];
                break;
              }
            }
          } catch (e) {}
        }
      }
    }
  }

  let outputLinks = [];

  if (TUIC_PORT.trim() !== "") {
    const tuicNodeLink = `tuic://${UUID}:${TUIC_PASS}@${serverIP}:${TUIC_PORT}?congestion_control=bbr&alpn=h3&sni=bing.com&allow_insecure=1#TUIC_${NAME}_${SHORT_UUID}`;
    outputLinks.push(tuicNodeLink);
  }

  if (ARGO_PORT.trim() !== "" && domain) {
    const plainNodeLink = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${domain}&fp=chrome&type=ws&host=${domain}&path=${WS_PATH}#Argo_${NAME}_${SHORT_UUID}`;
    outputLinks.push(plainNodeLink);
  }

  if (outputLinks.length > 0) {
    const rawLinksString = outputLinks.join("\n");
    const base64Sub = Buffer.from(rawLinksString, "utf-8").toString("base64");

    log(`\n====================== Base64 节点 ==========================\n${base64Sub}\n==============================================================\n`);

    const portSuffix = (WEB_PORT && WEB_PORT !== "80") ? `:${WEB_PORT}` : "";
    const httpSubUrl = `http://${serverIP}${portSuffix}/${URL_FILE_PATH}`;

    const subFileContent = `====================== Base64 节点 ==========================\n${base64Sub}\n\n====================== HTTP 订阅链接 ========================\n${httpSubUrl}\n==============================================================\n`;

    try {
      const subPath = path.isAbsolute(URL_FILE_PATH) ? URL_FILE_PATH : path.resolve(process.cwd(), URL_FILE_PATH);
      fs.writeFileSync(subPath, subFileContent, "utf-8");
      log(`[链接] Base64/订阅 已写入: ${subPath}`);
    } catch (e) {
      log(`[错误] 写入 ${URL_FILE_PATH} 失败: ${e.message}`);
    }
  } else {
    log(`[警告] 未能生成任何节点链接，请检查端口配置！`);
  }

  if (fs.existsSync(bootLogPath)) {
    try { fs.unlinkSync(bootLogPath); } catch (e) {}
  }

  // 清理 sing-box 临时提取文件
  if (fs.existsSync(webPath)) {
    try {
      fs.unlinkSync(webPath);
      log("[磁盘清理] sing-box 运行中，临时文件已释放");
    } catch (e) {
      log(`[清理提示] ${e.message}`);
    }
  }

  log("[引导完成] 守护进程持续运行中...");
  
  const keepAlive = () => setTimeout(keepAlive, 1000 * 60 * 60);
  keepAlive();
}

process.on("uncaughtException", (err) => {
  log(`[异常捕获] 未处理异常: ${err.message}`);
});

process.on("unhandledRejection", (reason) => {
  log(`[异常捕获] 未处理 Rejection: ${reason}`);
});

main().catch((err) => {
  console.error(`[致命错误] 运行失败: ${err.message}`);
});
