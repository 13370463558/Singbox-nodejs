#!/usr/bin/env node

// =================== Argo + TUIC 变量设置区域 开始 =======================

const TUIC_PORT = process.env.TUIC_PORT || "";                               // TUIC 端口（留空=不部署）

const ARGO_PORT = process.env.ARGO_PORT || "8001";                           // Argo回源端口填入8001 （留空=不部署）

const ARGO_PROTOCOL = process.env.ARGO_PROTOCOL || "quic";                   // http2或quic （http2=稳定+低占用；quic=响应快+占用略高）

const ARGO_CONNECTIONS = process.env.ARGO_CONNECTIONS || "1";                // 隧道连接数量 建议http2=4，quic=1 （多条UDP会增加占用，也可能会触发机房QoS）

const ARGO_DOMAIN = process.env.ARGO_DOMAIN || "";                           // 固定隧道域名

const ARGO_AUTH = process.env.ARGO_AUTH || "";                               // 固定隧道 Token

const CFIP = process.env.CFIP || "www.visa.com.hk";                          // 优选域名/IP（ www.wto.org  usa.visa.com  www.shopify.com) 

// ============================ 变量设置完成 ===============================

const CFPORT = process.env.CFPORT || 443;
const SUB_PORT = process.env.SUB_PORT || process.env.SERVER_PORT || process.env.PORT || "3000";
const FILE_PATH = process.env.FILE_PATH || ".tmp";
const URL_FILE_PATH = process.env.URL_FILE_PATH || "sub.txt";
const http = require("http");
const https = require("https");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { spawn, execSync } = require("child_process");

const log = (msg) => process.stdout.write(msg + "\n");

const iataMap = {
  HKG: "香港", TPE: "台湾", NRT: "日本", HND: "日本", KIX: "日本",
  ICN: "韩国", SIN: "新加坡", BKK: "泰国", MNL: "菲律宾", SGN: "越南",
  LAX: "美国", DFW: "美国", SJC: "美国", SEA: "美国", JFK: "美国", ORD: "美国",
  LHR: "英国", FRA: "德国", CDG: "法国", AMS: "荷兰", HEL: "芬兰"
};

const GO_BASE_ENV = {
  ...process.env,
  GODEBUG: "madvdontneed=1,cgocheck=0,netdns=go",
  GOMAXPROCS: "1",
  GOGC: "10"
};
const SINGBOX_MEM_LIMIT = "16MiB";
const CLOUDFLARED_MEM_LIMIT = "20MiB";

if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const uuidFilePath = path.join(FILE_PATH, "uuid.txt");
const tuicPwdFilePath = path.join(FILE_PATH, "tuic_password.txt");

let TUIC_PASSWORD = process.env.TUIC_PASSWORD || (fs.existsSync(tuicPwdFilePath) && fs.readFileSync(tuicPwdFilePath, "utf-8").trim());
if (!TUIC_PASSWORD) {
  TUIC_PASSWORD = crypto.randomBytes(16).toString("hex");
  try { fs.writeFileSync(tuicPwdFilePath, TUIC_PASSWORD, "utf-8"); } catch (e) {}
}

let UUID = process.env.UUID || (fs.existsSync(uuidFilePath) && fs.readFileSync(uuidFilePath, "utf-8").trim());
if (!UUID) {
  UUID = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex")).toLowerCase();
  try { fs.writeFileSync(uuidFilePath, UUID, "utf-8"); } catch (e) {}
} else {
  UUID = UUID.toLowerCase();
}
const WS_PATH = `/${UUID}-vless`;

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
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(targetPath);
      res.pipe(file);
      file.on("finish", () => { file.close(() => { req.destroy(); resolve(); }); });
    });
    req.on("error", (err) => { req.destroy(); try { fs.unlinkSync(targetPath); } catch (e) {} reject(err); });
  });
}

function getPublicIP() {
  try {
    return execSync("curl -s --max-time 2 ipv4.ip.sb || curl -s --max-time 1 api.ipify.org", { encoding: "utf-8" }).trim();
  } catch (e) {
    return "127.0.0.1";
  }
}

function generateCertificates(keyPath, certPath) {
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) return;
  try {
    execSync(`openssl ecparam -genkey -name prime256v1 -out "${keyPath}" 2>/dev/null && openssl req -new -x509 -days 3650 -key "${keyPath}" -out "${certPath}" -subj "/CN=bing.com" 2>/dev/null`);
    fs.chmodSync(keyPath, 0o600);
  } catch (e) {}
}

const webPath = path.join(FILE_PATH, "web");
const botPath = path.join(FILE_PATH, "bot");
const configPath = path.join(FILE_PATH, "config.json");
const certPath = path.join(FILE_PATH, "cert.pem");
const keyPath = path.join(FILE_PATH, "private.key");

const isArm = ["arm", "arm64", "aarch64"].includes(os.arch());
const SINGBOX_VER = "1.11.4";
const singboxTarUrl = `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VER}/sing-box-${SINGBOX_VER}-linux-${isArm ? "arm64" : "amd64"}.tar.gz`;
const cloudflaredUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${isArm ? "arm64" : "amd64"}`;

let webProc = null;
let botProc = null;
let isExiting = false;


async function startSingbox() {
  if (isExiting) return;
  try {
    if (!fs.existsSync(webPath)) {
      log("正在下载 sing-box...");
      const tempTar = path.join(FILE_PATH, "singbox.tar.gz");
      await downloadFile(singboxTarUrl, tempTar);
      execSync(`tar -xzf "${tempTar}" -C "${FILE_PATH}" --wildcards "*/sing-box" --strip-components=1 || tar -xzf "${tempTar}" -C "${FILE_PATH}" sing-box`);
      const extractedPath = path.join(FILE_PATH, "sing-box");
      if (fs.existsSync(extractedPath) && extractedPath !== webPath) fs.renameSync(extractedPath, webPath);
      try { fs.unlinkSync(tempTar); } catch (e) {}
    }
    fs.chmodSync(webPath, 0o775);

    webProc = spawn(webPath, ["run", "-c", configPath], {
      env: Object.assign({}, GO_BASE_ENV, { GOMEMLIMIT: SINGBOX_MEM_LIMIT }),
      stdio: ["ignore", "ignore", "pipe"],
      detached: true
    });

    setTimeout(() => {
      if (fs.existsSync(webPath)) {
        try { 
          fs.unlinkSync(webPath); 
          log("[存储优化]sing-box 保活中，web文件已清理"); 
        } catch (e) {}
      }
    }, 15000);

    webProc.on("exit", (code, signal) => {
      if (isExiting) return;
      log(`[警告] sing-box 意外退出 (code: ${code})，3秒后自动重新下载并拉起保活...`);
      setTimeout(() => {
        startSingbox().catch(e => log(`[保活错误] ${e.message}`));
      }, 3000);
    });

  } catch (err) {
    log(`[错误] sing-box 启动失败: ${err.message}，5秒后重试...`);
    if (!isExiting) setTimeout(startSingbox, 5000);
  }
}


async function startCloudflared(argoArgs, isFixedTunnel, setArgoLink, updateSubFile) {
  if (isExiting) return;
  try {
    if (!fs.existsSync(botPath)) {
      log("正在下载 Cloudflared...");
      await downloadFile(cloudflaredUrl, botPath);
    }
    fs.chmodSync(botPath, 0o775);


    if (!isFixedTunnel) {
      log("未检测到 Token，启动临时隧道...");
    } else {
      log("检测到 Token，启动固定隧道...");
    }

    botProc = spawn(botPath, argoArgs, {
      env: Object.assign({}, GO_BASE_ENV, { GOMEMLIMIT: CLOUDFLARED_MEM_LIMIT }),
      stdio: ["ignore", "pipe", "pipe"], detached: true
    });

    const activeConnectionsMap = new Map();
    const rl = readline.createInterface({ input: botProc.stderr });

    // ⚡ 抽出单独的处理逻辑，以便在拿到域名后第一时间彻底销毁监听器，切断晚高峰日志流
    const onLineHandler = (chunk) => {
      const cleanLine = chunk.replace(/\u001b\[[0-9;]*m/g, "");

      if (!isFixedTunnel) {
        const domainMatch = cleanLine.match(/https:\/\/([a-zA-Z0-9-]+\.trycloudflare\.com)/);
        if (domainMatch) {
          setArgoLink(domainMatch[1]);
          updateSubFile(true);
          // ⚡【核心优化】拿到临时域名后，立刻关闭 readline，不再解析后续海量日志！
          rl.close();
          try { botProc.stderr.unref(); } catch (e) {}
        }
      }

      const connMatch = cleanLine.match(/connIndex=(\d+)/i) || cleanLine.match(/"connIndex":(\d+)/i);
      const locMatch = cleanLine.match(/(?:location|region)["=:\s]+([a-zA-Z0-9]{3,4})/i) ||
                        cleanLine.match(/Registered tunnel connection.*?\b([A-Z0-9]{3,4})\b/i);

      if (locMatch) {
        const rawCode = locMatch[1].toUpperCase();
        const iataCode = rawCode.replace(/[0-9]/g, "");
        const country = iataMap[iataCode] || iataCode;
        const connId = connMatch ? connMatch[1] : String(activeConnectionsMap.size);

        if (!activeConnectionsMap.has(connId)) {
          activeConnectionsMap.set(connId, rawCode);
          log(`[Cloudflare CDN] 已连接边缘节点：${rawCode}（${country}） | 协议：${ARGO_PROTOCOL.toLowerCase()}`);
        }
      }
    };

    rl.on("line", onLineHandler);

    setTimeout(() => {
      try {
        rl.close();
        if (botProc && botProc.stderr) botProc.stderr.unref();
      } catch (e) {}
    }, 60000);

    rl.on("line", onLineHandler);

    setTimeout(() => {
      try {
        rl.close();
        if (botProc && botProc.stderr) botProc.stderr.unref();
      } catch (e) {}
    }, 60000);

    botProc.on("exit", (code, signal) => {
      if (isExiting) return;
      log(`[警告] cloudflared 进程意外退出 (code: ${code}, signal: ${signal})，3秒后自动重连...`);
      setTimeout(() => startCloudflared(argoArgs, isFixedTunnel, setArgoLink, updateSubFile), 3000);
    });

  } catch (err) {
    log(`[错误] cloudflared 启动失败: ${err.message}，5秒后重试...`);
    if (!isExiting) setTimeout(() => startCloudflared(argoArgs, isFixedTunnel, setArgoLink, updateSubFile), 5000);
  }
}

async function main() {
  const enableArgo = Boolean(ARGO_PORT && String(ARGO_PORT).trim() !== "" && String(ARGO_PORT).trim() !== "0");
  const enableTuic = Boolean(TUIC_PORT && String(TUIC_PORT).trim() !== "" && String(TUIC_PORT).trim() !== "0");

  if (!enableArgo && !enableTuic) {
    log("[退出] 未配置 ARGO_PORT 或 TUIC_PORT");
    process.exit(0);
  }

  try { execSync("pkill -9 -f sing-box || pkill -9 -f cloudflared", { stdio: "ignore" }); } catch (e) {}

  const subPortInt = parseInt(SUB_PORT, 10);
  const isValidSubPort = !isNaN(subPortInt) && subPortInt > 0 && subPortInt <= 65535;

  if (isValidSubPort) { try { execSync(`fuser -k -9 ${subPortInt}/tcp`, { stdio: "ignore" }); } catch (e) {} }
  if (enableTuic) { try { execSync(`fuser -k -9 ${TUIC_PORT}/udp`, { stdio: "ignore" }); } catch (e) {} }

  const inbounds = [];
  if (enableArgo) {
    inbounds.push({
      type: "vless", tag: "vless-in", listen: "127.0.0.1", listen_port: parseInt(ARGO_PORT),
      users: [{ uuid: UUID }], transport: { type: "ws", path: WS_PATH }
    });
  }
  if (enableTuic) {
    generateCertificates(keyPath, certPath);
    inbounds.push({
      type: "tuic", tag: "tuic-in", listen: "::", listen_port: parseInt(TUIC_PORT),
      users: [{ uuid: UUID, password: TUIC_PASSWORD }], congestion_control: "bbr",
      tls: { enabled: true, alpn: ["h3"], certificate_path: certPath, key_path: keyPath }
    });
  }

  fs.writeFileSync(configPath, JSON.stringify({
    log: { level: "panic" },
    inbounds: inbounds,
    outbounds: [{ type: "direct", tag: "direct", udp_fragment: true }]
  }));

  await startSingbox();

  let argoNodeLink = "";
  let tuicNodeLink = "";
  const authTrim = ARGO_AUTH.trim();
  const isFixedTunnel = authTrim.length > 30;

  let hasPrintedConsole = false;
  const updateSubFile = (forceConsole = false) => {
    const rawLinksText = [argoNodeLink, tuicNodeLink].filter(Boolean).join("\r\n");
    if (!rawLinksText) return;
    
    const base64Sub = Buffer.from(rawLinksText).toString("base64");
    const consoleFormatted = `====================== Base64链接 ==========================\n${base64Sub}\n==============================================================`;

    let subFileFormatted = consoleFormatted;
    if (isValidSubPort) {

      subFileFormatted += `\n\nhttps安全订阅链接:\nhttps://${getPublicIP()}:${subPortInt}/${UUID}`;
    }

    if (!hasPrintedConsole || forceConsole) {
      log(`\n${consoleFormatted}`);
      hasPrintedConsole = true;
    }

    try { 
      fs.writeFileSync(URL_FILE_PATH, subFileFormatted, "utf-8"); 
      log(`[链接] Base64/https安全订阅 已写入: ${URL_FILE_PATH}`);
    } catch (e) {}
  };

  if (enableTuic) {
    tuicNodeLink = `tuic://${UUID}:${TUIC_PASSWORD}@${getPublicIP()}:${TUIC_PORT}?sni=www.bing.com&alpn=h3&congestion_control=bbr&allowInsecure=1#TUIC_Easyshare`;
  }

  if (enableArgo) {
    let argoArgs = ["tunnel", "--no-autoupdate", "--protocol", ARGO_PROTOCOL.toLowerCase(), "--ha-connections", ARGO_CONNECTIONS];
    const setArgoLink = (domain) => {
      argoNodeLink = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${domain}&fp=chrome&type=ws&host=${domain}&path=${encodeURIComponent(WS_PATH)}#Argo_Easyshare`;
    };

    if (isFixedTunnel) {
      argoArgs.push("run", "--token", authTrim);
      if (ARGO_DOMAIN.trim()) setArgoLink(ARGO_DOMAIN.trim());
    } else {
      argoArgs.push("--url", `http://127.0.0.1:${ARGO_PORT}`);
    }

    await startCloudflared(argoArgs, isFixedTunnel, setArgoLink, updateSubFile);

    if (isFixedTunnel) {
      updateSubFile(true);
    }
  }


  if (isValidSubPort) {

    generateCertificates(keyPath, certPath);

    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };

    https.createServer(httpsOptions, (req, res) => {
      if (req.url.split("?")[0] === `/${UUID}`) {
        const rawLinksArr = [argoNodeLink, tuicNodeLink].filter(Boolean);
        if (rawLinksArr.length > 0) {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
          // ⚡ 生成响应内容
          const subContent = Buffer.from(rawLinksArr.join("\r\n")).toString("base64");
          res.end(subContent);
          // ⚡ 订阅拉取完成后，主动清除可能残余的无用引用
          if (global.gc) {
            try { global.gc(); } catch (e) {}
          }
        } else {
          res.writeHead(404); res.end("Not Ready");
        }
      } else {
        res.writeHead(404); res.end("404");
      }
    }).listen(subPortInt, () => log("[订阅服务] https安全订阅已启用"));
  } 
  if (!enableArgo) {
    updateSubFile();
  }

  const cleanup = () => {
    isExiting = true;
    try { if (webProc) webProc.kill("SIGKILL"); } catch (e) {}
    try { if (botProc) botProc.kill("SIGKILL"); } catch (e) {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.stdin.resume();
}
main().catch((err) => { log(`[错误] ${err.message}`); process.exit(1); });
