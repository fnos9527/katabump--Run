#!/usr/bin/env python3
"""把 vless:// 链接转成 sing-box 配置(本地 SOCKS5 127.0.0.1:1080)。
支持 transport: tcp / ws / grpc / http(h2) / httpupgrade;安全层: none / tls / reality。
"""
import json, sys
from urllib.parse import urlparse, parse_qs, unquote


def build(link: str) -> dict:
    u = urlparse(link.strip())
    if u.scheme != "vless":
        raise SystemExit("NODE_LINK 不是 vless:// 链接")
    q = {k: v[0] for k, v in parse_qs(u.query).items()}
    host, port = u.hostname, u.port or 443
    ttype = q.get("type", "tcp")
    security = q.get("security", "none")
    sni = q.get("sni") or q.get("host") or host

    out = {
        "type": "vless", "tag": "proxy",
        "server": host, "server_port": int(port),
        "uuid": unquote(u.username or ""),
        "packet_encoding": "xudp",
    }
    if q.get("flow"):
        out["flow"] = q["flow"]

    if security in ("tls", "reality"):
        tls = {"enabled": True, "server_name": sni}
        if q.get("alpn"):
            tls["alpn"] = q["alpn"].split(",")
        if q.get("allowInsecure") in ("1", "true") or q.get("insecure") in ("1", "true"):
            tls["insecure"] = True
        fp = q.get("fp")
        if fp or security == "reality":
            tls["utls"] = {"enabled": True, "fingerprint": fp or "chrome"}
        if security == "reality":
            tls["reality"] = {"enabled": True,
                              "public_key": q.get("pbk", ""),
                              "short_id": q.get("sid", "")}
        out["tls"] = tls

    path = unquote(q.get("path", "/")) or "/"
    hosthdr = q.get("host") or sni
    if ttype == "ws":
        out["transport"] = {"type": "ws", "path": path,
                            "headers": {"Host": hosthdr}}
    elif ttype == "grpc":
        out["transport"] = {"type": "grpc",
                            "service_name": unquote(q.get("serviceName", ""))}
    elif ttype in ("http", "h2"):
        out["transport"] = {"type": "http", "path": path,
                            "host": [h for h in hosthdr.split(",") if h]}
    elif ttype == "httpupgrade":
        out["transport"] = {"type": "httpupgrade", "path": path, "host": hosthdr}
    # tcp: 不加 transport

    return {
        "log": {"level": "warn"},
        "inbounds": [{"type": "socks", "tag": "in",
                      "listen": "127.0.0.1", "listen_port": 1080}],
        "outbounds": [out, {"type": "direct", "tag": "direct"}],
        "route": {"final": "proxy"},
    }


if __name__ == "__main__":
    print(json.dumps(build(sys.argv[1]), ensure_ascii=False, indent=2))
