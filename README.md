# katabump--Run
USERS_JSON   =你的邮箱:你的密码     
SERVER_URL     =See链接     
HTTP_PROXY   =VLESS 格式


vless:// 链接.改为读取 URL 里的 type 参数（默认 tcp），根据值分别生成 wsSettings / tcpSettings / grpcSettings / httpSettings。
增加 fp（TLS 指纹）和 insecure/allowInsecure 的兼容处理，两种参数名都认，值为 1 或 true 都算跳过证书校验
sni 缺失时自动兜底为 host 参数或服务器地址本身，避免有些节点没写 sni 导致握手失败。
uuid 做了 decodeURIComponent，防止用户名部分被编码；
path 做了 URL 解码并自动补 /；
处理 IPv6 地址形如 [::1] 的情况；
增加 reality 安全层的兼容（万一以后你用到 REALITY 节点也不用再改）；
安装 xray-core 将 VLESS 节点转为本地 Socks5 代理使用这个本地 Socks5 代理工作。
Secret 名称=VLESS_LINK 。值 =粘贴我的 vless:// 链接
