# katabump--Run
USERS_JSON   =你的邮箱:你的密码     
SERVER_URL     =See链接     
HTTP_PROXY   =VLESS 格式


vless:// 链接.改为读取 URL 里的 type 参数（默认 tcp），根据值分别生成 wsSettings / tcpSettings / grpcSettings / httpSettings兼容多种格式。   
增加 fp（TLS 指纹）和 insecure/allowInsecure 的兼容处理，两种参数名都认，值为 1 或 true 都算跳过证书校验    
sni 缺失时自动兜底为 host 参数或服务器地址本身，避免有些节点没写 sni 导致握手失败。   
uuid 做了 decodeURIComponent，防止用户名部分被编码；       
path 做了 URL 解码并自动补 /；   
处理 IPv6 地址形如 [::1] 的情况；   
增加 reality 安全层的兼容（万一以后你用到 REALITY 节点也不用再改）；   
安装 xray-core 将 VLESS 节点转为本地 Socks5 代理使用这个本地 Socks5 代理工作。   
Secret 名称=VLESS_LINK 。值 =粘贴我的 vless:// 链接    


latest 版 Xray（v26.x）→ 配置里带 allowInsecure 字段直接被拒绝启动（新版彻底移除了这个字段）。    
固定用的是 v25.9.11——这个版本本身就是 allowInsecure 被移除之前发布的，它对这个字段的处理是"真的会跳过校验"，而不是新版那种"看到就报错拒绝"。   
所以直接沿用 allowInsecure: true 才是这个版本组合下真正正确的写法，能彻底绕开这种老式证书的校验问题。
