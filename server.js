const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const port = 8765;
const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
const secrets = JSON.parse(fs.readFileSync(path.join(root, "secrets.json"), "utf8"));

function send(res, status, body, type) {
  res.writeHead(status, { "Content-Type": type || "text/plain" });
  res.end(body);
}

function postForm(url, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const req = https.request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, json: { raw } }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getJson(url, token) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: "Bearer " + token } }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ raw }); }
      });
    }).on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:" + port);
  if (url.pathname === "/oauth/start") {
    const state = crypto.randomBytes(16).toString("hex");
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.searchParams.set("client_id", secrets.clientId);
    auth.searchParams.set("redirect_uri", redirectUri);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", "openid email profile https://www.googleapis.com/auth/drive.appdata");
    auth.searchParams.set("state", state);
    auth.searchParams.set("access_type", "online");
    auth.searchParams.set("prompt", "select_account");
    res.writeHead(302, { Location: auth.toString(), "Set-Cookie": "oauth_state=" + state + "; HttpOnly; Path=/; Max-Age=600" });
    res.end();
    return;
  }
  if (url.pathname === "/oauth/callback") {
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");
    if (err || !code) {
      send(res, 400, "Google sign-in did not finish: " + (err || "missing code"));
      return;
    }
    const token = await postForm("https://oauth2.googleapis.com/token", {
      code,
      client_id: secrets.clientId,
      client_secret: secrets.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    if (!token.json.access_token) {
      send(res, 400, "Google did not return a sign-in. " + (token.json.error_description || token.json.error || ""));
      return;
    }
    const profile = await getJson("https://www.googleapis.com/oauth2/v3/userinfo", token.json.access_token);
    const user = { sub: profile.sub, name: profile.name, email: profile.email, picture: profile.picture };
    const packed = encodeURIComponent(JSON.stringify(user));
    const access = {
      accessToken: token.json.access_token,
      expiresAt: Date.now() + (Number(token.json.expires_in) || 3600) * 1000,
      sub: user.sub,
    };
    const page = "<!doctype html><meta charset=\"utf-8\"><title>Signing in</title><script>sessionStorage.setItem(\"school-tracker-access\"," + JSON.stringify(JSON.stringify(access)) + ");location.replace(" + JSON.stringify("/#signed-in=" + packed) + ");</script>";
    send(res, 200, page, "text/html");
    return;
  }
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === "/") filePath = "/index.html";
  const full = path.join(root, filePath);
  if (!full.startsWith(root) || path.basename(full) === "secrets.json") {
    send(res, 404, "no");
    return;
  }
  fs.readFile(full, (error, data) => {
    if (error) { send(res, 404, "no"); return; }
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
    send(res, 200, data, types[path.extname(full)] || "text/plain");
  });
});

server.listen(port, () => console.log("up " + port));
