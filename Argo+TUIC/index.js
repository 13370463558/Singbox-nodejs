#!/usr/bin/env node

// =================== Argo + TUIC 变量设置区域 开始 =======================

const TUIC_PORT = process.env.TUIC_PORT || "";                                // TUIC端口（留空=不部署）

const ARGO_PORT = process.env.ARGO_PORT || "8001";                            // Argo回源端口填入8001（留空=不部署）

const ARGO_PROTOCOL = process.env.ARGO_PROTOCOL || "quic";                    // http2或quic （http2=稳定+低占用；quic=响应快+占用略高）

const ARGO_CONNECTIONS = process.env.ARGO_CONNECTIONS || "1";                 // 隧道连接数量 建议http2=4，quic=1 （多条UDP会增加占用，也可能会触发机房QoS）

const ARGO_DOMAIN = process.env.ARGO_DOMAIN || "";                            // 固定隧道域名

const ARGO_AUTH = process.env.ARGO_AUTH || "";                                // 固定隧道Token

const CFIP = process.env.CFIP || "www.wto.org";                               // 优选域名（ www.visa.com.hk  usa.visa.com  www.shopify.com) 

// ============================ 变量设置完成 ===============================

const CFPORT = process.env.CFPORT || "443";                                
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

const iataMap = {
  HKG: "香港", TPE: "台湾", NRT: "日本", HND: "日本", KIX: "日本",
  ICN: "韩国", SIN: "新加坡", BKK: "泰国", MNL: "菲律宾", SGN: "越南",
  LAX: "美国", DFW: "美国", SJC: "美国", SEA: "美国", JFK: "美国", ORD: "美国",
  LHR: "英国", FRA: "德国", CDG: "法国", AMS: "荷兰", HEL: "芬兰"
};

const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
let singboxMemLimit, cloudflaredMemLimit, dynamicGOGC, dynamicProcs;

if (totalMemMB <= 160) {
  singboxMemLimit = "38MiB";
  cloudflaredMemLimit = "65MiB";
  dynamicGOGC = "80";     
  dynamicProcs = "1";     
} else if (totalMemMB < 256) {
  singboxMemLimit = "80MiB";
  cloudflaredMemLimit = "140MiB";
  dynamicGOGC = "100";
  dynamicProcs = "2";
} else if (totalMemMB < 320) {
  singboxMemLimit = "128MiB";
  cloudflaredMemLimit = "220MiB";
  dynamicGOGC = "100";    
  dynamicProcs = "2";     
} else if (totalMemMB < 448) {
  singboxMemLimit = "160MiB";
  cloudflaredMemLimit = "320MiB";
  dynamicGOGC = "100";
  dynamicProcs = "2";
} else if (totalMemMB < 576) {
  singboxMemLimit = "200MiB";
  cloudflaredMemLimit = "400MiB";
  dynamicGOGC = "100";
  dynamicProcs = "2";
} else {
  singboxMemLimit = "384MiB";
  cloudflaredMemLimit = "768MiB";
  dynamicGOGC = "100";    
  dynamicProcs = process.env.GOMAXPROCS || "4"; 
}

const GO_BASE_ENV = {
  ...process.env,
  GODEBUG: "madvdontneed=1,cgocheck=0,netdns=go",
  GOMAXPROCS: process.env.GOMAXPROCS || dynamicProcs,
  GOGC: process.env.GOGC || dynamicGOGC
};

if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const uuidFilePath = path.join(FILE_PATH, "uuid.txt");
const tuicPwdFilePath = path.join(FILE_PATH, "tuic_password.txt");

let rawTuicPassword = process.env.TUIC_PASSWORD || (fs.existsSync(tuicPwdFilePath) && fs.readFileSync(tuicPwdFilePath, "utf-8").trim());
if (!rawTuicPassword) {
  rawTuicPassword = crypto.randomBytes(16).toString("hex");
  try { fs.writeFileSync(tuicPwdFilePath, rawTuicPassword, "utf-8"); } catch (e) {}
}
const TUIC_PASSWORD = rawTuicPassword;

let rawUUID = process.env.UUID || (fs.existsSync(uuidFilePath) && fs.readFileSync(uuidFilePath, "utf-8").trim());
if (!rawUUID) {
  rawUUID = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  try { fs.writeFileSync(uuidFilePath, rawUUID, "utf-8"); } catch (e) {}
}
const UUID = rawUUID.toLowerCase();
const WS_PATH = `/${UUID}-vless`;
const log = (msg) => process.stdout.write(msg + "\n");

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

function extractSingbox(tarPath, targetWebPath) {
  execSync(`tar -xzf "${tarPath}" -C "${FILE_PATH}" --wildcards "*/sing-box" --strip-components=1 || tar -xzf "${tarPath}" -C "${FILE_PATH}" sing-box`);
  const extractedPath = path.join(FILE_PATH, "sing-box");
  if (fs.existsSync(extractedPath) && extractedPath !== targetWebPath) {
    fs.renameSync(extractedPath, targetWebPath);
  }
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
  } catch (e) {
    try {
      const { generateKeyPairSync } = crypto;
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const pemKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
      fs.writeFileSync(keyPath, pemKey);
      fs.chmodSync(keyPath, 0o600);

      execSync(`openssl req -new -x509 -days 3650 -key "${keyPath}" -out "${certPath}" -subj "/CN=bing.com" 2>/dev/null`);
    } catch (err) {
      log("[警告] 证书生成异常: " + err.message);
    }
  }
}

const webPath = path.join(FILE_PATH, "web");
const botPath = path.join(FILE_PATH, "cloudflared");
const configPath = path.join(FILE_PATH, "config.json");
const certPath = path.join(FILE_PATH, "cert.pem");
const keyPath = path.join(FILE_PATH, "private.key");

async function main() {
  const enableArgo = Boolean(ARGO_PORT && String(ARGO_PORT).trim() !== "" && String(ARGO_PORT).trim() !== "0");
  const enableTuic = Boolean(TUIC_PORT && String(TUIC_PORT).trim() !== "" && String(TUIC_PORT).trim() !== "0");

  if (!enableArgo && !enableTuic) {
    log("[退出] 未检测到有效的 ARGO_PORT 或 TUIC_PORT 配置。");
    process.exit(0);
  }

  try { execSync("pkill -9 -f sing-box", { stdio: "ignore" }); } catch (e) {}
  try { execSync("pkill -9 -f cloudflared", { stdio: "ignore" }); } catch (e) {}
  if (SUB_PORT) { try { execSync(`fuser -k -9 ${SUB_PORT}/tcp`, { stdio: "ignore" }); } catch (e) {} }
  if (TUIC_PORT) { try { execSync(`fuser -k -9 ${TUIC_PORT}/udp`, { stdio: "ignore" }); } catch (e) {} }

  generateCertificates(keyPath, certPath);

  const inbounds = [];
  if (enableArgo) {
    inbounds.push({
      type: "vless", tag: "vless-in", listen: "127.0.0.1", listen_port: parseInt(ARGO_PORT),
      users: [{ uuid: UUID }], transport: { type: "ws", path: WS_PATH }
    });
  }
  if (enableTuic) {
    inbounds.push({
      type: "tuic", tag: "tuic-in", listen: "::", listen_port: parseInt(TUIC_PORT),
      users: [{ uuid: UUID, password: TUIC_PASSWORD }], congestion_control: "bbr",
      tls: { enabled: true, alpn: ["h3"], certificate_path: certPath, key_path: keyPath }
    });
  }

  fs.writeFileSync(configPath, JSON.stringify({
    log: { level: "panic" },
    inbounds: inbounds,
    outbounds: [{ 
      type: "direct", 
      tag: "direct", 
      udp_fragment: true,
    }]
  }, null, 2));

  const isArm = ["arm", "arm64", "aarch64"].includes(os.arch());
  const SINGBOX_VER = "1.11.4";
  const singboxTarUrl = `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VER}/sing-box-${SINGBOX_VER}-linux-${isArm ? "arm64" : "amd64"}.tar.gz`;

  if (!fs.existsSync(webPath)) {
    log("正在下载 sing-box ...");
    const tempTar = path.join(FILE_PATH, "singbox.tar.gz");
    await downloadFile(singboxTarUrl, tempTar);
    extractSingbox(tempTar, webPath);
    try { fs.unlinkSync(tempTar); } catch (e) {}
  }
  fs.chmodSync(webPath, 0o775);

  let webProc = spawn(webPath, ["run", "-c", configPath], {
    env: Object.assign({}, GO_BASE_ENV, { GOMEMLIMIT: singboxMemLimit }), 
    stdio: ["ignore", "ignore", "pipe"],
    detached: true
  });

  await new Promise((r) => setTimeout(r, 1000));

  let argoNodeLink = "";
  let tuicNodeLink = "";

  const authTrim = ARGO_AUTH.trim();
  const isFixedTunnel = authTrim.length > 30;

  const rawPort = SUB_PORT || process.env.SERVER_PORT;
  const subPortInt = parseInt(rawPort, 10);
  const isValidSubPort = !isNaN(subPortInt) && subPortInt > 0 && subPortInt <= 65535;

  let printedOnce = false;

  const updateSubFile = () => {
    if (enableArgo && !argoNodeLink) return;
    if (enableTuic && !tuicNodeLink) return;

    const rawLinksArr = [argoNodeLink, tuicNodeLink].filter(Boolean);
    const rawLinksText = rawLinksArr.join("\r\n");
    if (!rawLinksText) return;
    const base64Sub = Buffer.from(rawLinksText).toString("base64");

    const topDivider    = "====================== Base64链接 ==========================";
    const bottomDivider = "==============================================================";

    let fileOutputContent = `${topDivider}\n${base64Sub}`;
    if (isValidSubPort) {
      const publicIP = getPublicIP();
      const httpsSubUrl = `https://${publicIP}:${subPortInt}/${UUID}`;
      fileOutputContent += `\n\n${bottomDivider}\n\nhttps安全订阅链接:\n${httpsSubUrl}`;
    }

    if (!printedOnce) {
      log(`\n${fileOutputContent}`);
      printedOnce = true;
    }

    try {
      fs.writeFileSync(URL_FILE_PATH, fileOutputContent, "utf-8");
      log(`[链接] Base64/https安全订阅 已写入: ${URL_FILE_PATH}`);
    } catch (e) {
      log(`[存储] 写入文件失败: ${e.message}`);
    }
  };

  if (enableTuic) {
    const publicIP = getPublicIP();
    tuicNodeLink = `tuic://${UUID}:${TUIC_PASSWORD}@${publicIP}:${TUIC_PORT}?sni=www.bing.com&alpn=h3&congestion_control=bbr&allowInsecure=1#TUIC_Easyshare`;
  }

  if (isValidSubPort) {
    const options = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath)
    };

    const server = https.createServer(options, (req, res) => {
      if (req.url === `/${UUID}`) {
  const rawLinksArr = [argoNodeLink, tuicNodeLink].filter(Boolean);
  const rawText = rawLinksArr.join("\r\n").trim();
  if (rawText) { // ✅ 判断拼接后的实际内容，确保有有效节点
    const base64Only = Buffer.from(rawText).toString("base64");
    res.writeHead(200, { /* ... headers ... */ });
    res.end(base64Only);
  } else {
    res.writeHead(404); res.end("Subscription not ready.");
        }
      } else {
        res.writeHead(404); res.end("404 Not Found");
      }
    });

    server.listen(subPortInt, () => {
      log(`[订阅服务] https安全订阅已启用`);
    }).on("error", (err) => {
      log(`[订阅服务] 启动失败: ${err.message}`);
    });
  }

  let botProc = null;
  if (enableArgo) {
    const cloudflaredUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${isArm ? "arm64" : "amd64"}`;
    if (!fs.existsSync(botPath)) {
      log("正在下载 Cloudflared...");
      await downloadFile(cloudflaredUrl, botPath);
    }
    fs.chmodSync(botPath, 0o775);

    let argoArgs = ["tunnel", "--no-autoupdate", "--protocol", ARGO_PROTOCOL.toLowerCase(), "--ha-connections", String(ARGO_CONNECTIONS)];

    const cleanCFIP = CFIP.trim().replace(/\s+/g, "");

    const setArgoLink = (domain) => {
      const cleanDomain = domain.trim().replace(/\s+/g, "");
      argoNodeLink = `vless://${UUID}@${cleanCFIP}:${CFPORT}?encryption=none&security=tls&sni=${cleanDomain}&fp=chrome&type=ws&host=${cleanDomain}&path=${encodeURIComponent(WS_PATH)}#Argo_Easyshare`;
    };

    if (isFixedTunnel) {
      log(`[Argo] 检测到Token，启动固定隧道...`);
      argoArgs.push("run", "--token", authTrim);
      if (ARGO_DOMAIN.trim()) {
        setArgoLink(ARGO_DOMAIN.trim());
        updateSubFile();
      }
    } else {
      log(`[Argo] 未检测到Token，启动临时隧道...`);
      argoArgs.push("--url", `http://127.0.0.1:${ARGO_PORT}`);
    }

    botProc = spawn(botPath, argoArgs, {
      env: Object.assign({}, GO_BASE_ENV, { GOMEMLIMIT: cloudflaredMemLimit }), 
      stdio: ["ignore", "pipe", "pipe"], detached: true
    });

    const activeConnectionsMap = new Map();
    const rl = readline.createInterface({ input: botProc.stderr });

    rl.on("line", (chunk) => {
      const cleanLine = chunk.replace(/\u001b\[[0-9;]*m/g, "");

      // 1. 捕获临时域名
      if (!isFixedTunnel && !argoNodeLink) {
        const domainMatch = cleanLine.match(/https?:\/\/([a-zA-Z0-9-]+\.trycloudflare\.com)/i) ||
                            cleanLine.match(/([a-zA-Z0-9-]+\.trycloudflare\.com)/i);
        if (domainMatch) {
          setArgoLink(domainMatch[1]);
          updateSubFile();
        }
      }

      // 2. 捕获 CDN 边缘节点国别
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

      
      const hasCdnOutput = activeConnectionsMap.size > 0;
      const isReadyToClose = isFixedTunnel ? hasCdnOutput : (hasCdnOutput && Boolean(argoNodeLink));

      if (isReadyToClose) {
        rl.close(); 
        }
    });

  } else {
    updateSubFile();
  }

  const cleanup = () => {
    try { if (webProc) webProc.kill("SIGKILL"); } catch (e) {}
    try { if (botProc) botProc.kill("SIGKILL"); } catch (e) {}
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  process.stdin.resume();
}

main().catch((err) => {
  log(`[致命错误] ${err.message}`);
  process.exit(1);
});
