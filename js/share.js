/* 分享（v3.5 V3）：把当前整刊排版生成给他人审阅的载体
 *  - 线上长链接：serializeState → JSON → LZ 压缩 → base64 → URL hash（#share=…）
 *  - 自包含 HTML：当前 #preview 的页面 HTML + 样式表 + 图片内联，双击即可本地打开
 * 纯前端、无后端；链接依赖已上线的线上工具地址，文件则完全离线。
 */
const Share = (() => {
  const ONLINE_URL = 'https://xiaobaigu16.github.io/kanwu-layout-tool/';
  function $(id) { return document.getElementById(id); }

  // ---------- LZW 压缩（标准算法：先 UTF-8 转字节，字面量码 0-255、字典码 256+） ----------
  // 关键修复：上一版把「中文字面量码（如 测=27979）」直接当码输出，与字典编号空间冲突，
  // 解码端无法区分，导致中文往返失败。现按 UTF-8 拆成字节（每个 0-255）后再做标准 LZW，
  // 字面量与字典码分处不同空间，中文/emoji 均安全可逆。
  function codesToB64(codes) {
    const bytes = new Uint8Array(codes.length * 2);
    codes.forEach((n, i) => { bytes[i * 2] = (n >> 8) & 0xff; bytes[i * 2 + 1] = n & 0xff; });
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(bin);
  }
  function b64ToCodes(b64) {
    const bin = atob(b64);
    if (bin.length % 2) return [];
    const codes = [];
    for (let i = 0; i < bin.length; i += 2) codes.push((bin.charCodeAt(i) << 8) | bin.charCodeAt(i + 1));
    return codes;
  }
  function lzCompress(input) {
    // UTF-8 字节流 → 每字节严格映射为一个 0-255 的字符（不能用 TextDecoder('latin1')：
    // 它实际按 windows-1252 解码，会把 0x80-0x9F 的 UTF-8 连续字节映射成 U+2018/2019 等
    // >255 字符，污染字节流导致解码失败）。
    const bytes = new TextEncoder().encode(input);
    let raw = '';
    for (let i = 0; i < bytes.length; i += 8192)
      raw += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    if (!raw.length) return '';
    const dict = new Map();
    const MAX = 65535;
    let next = 256, w = raw[0], out = [];
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i], wc = w + c;
      if (dict.has(wc)) { w = wc; continue; }
      out.push(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
      if (next <= MAX) dict.set(wc, next++);
      w = c;
    }
    out.push(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
    return codesToB64(out);
  }
  function lzDecompress(b64) {
    if (!b64) return '';
    const codes = b64ToCodes(b64);
    if (!codes.length) return '';
    const dict = new Map();
    let next = 256;
    let w = String.fromCharCode(codes[0]);
    let out = w;
    for (let i = 1; i < codes.length; i++) {
      const k = codes[i];
      let entry;
      if (k < 256) entry = String.fromCharCode(k);
      else if (dict.has(k)) entry = dict.get(k);
      else if (k === next) entry = w + w[0];
      else return null;
      out += entry;
      if (next <= 65535) dict.set(next++, w + entry[0]);
      w = entry;
    }
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return new TextDecoder().decode(bytes);
  }

  function currentStateJson() {
    const raw = JSON.stringify(window.App && App.serialize ? App.serialize() : null);
    return raw;
  }

  function genLink() {
    const inp = $('shareUrl');
    if (!inp) return;
    const json = currentStateJson();
    if (!json || json === 'null') { U.toast('当前没有可分享的排版'); return; }
    try {
      const packed = lzCompress(json);
      const url = ONLINE_URL + '#share=' + encodeURIComponent(packed);
      inp.value = url;
      $('shareInfo').textContent = `链接已生成（约 ${(url.length / 1024).toFixed(1)} KB，可直接复制发送）`;
      U.toast('分享链接已生成，点「复制链接」发送');
    } catch (e) {
      U.toast('生成链接失败：' + (e.message || e));
    }
  }

  function copyLink() {
    const inp = $('shareUrl');
    if (!inp || !inp.value) { U.toast('请先点「生成链接」'); return; }
    inp.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    if (!ok && navigator.clipboard) { navigator.clipboard.writeText(inp.value); ok = true; }
    U.toast(ok ? '链接已复制' : '请手动选中链接复制');
  }

  // ---------- 自包含 HTML ----------
  function collectCss() {
    let css = '';
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) css += rule.cssText + '\n';
      } catch (e) { /* 跨域样式跳过 */ }
    }
    return css;
  }
  function genHtml() {
    if (!window.App || !App.state.docs.length) { U.toast('当前没有可分享的排版'); return; }
    const preview = document.getElementById('preview');
    if (!preview) { U.toast('找不到预览内容'); return; }
    // 抓取当前预览页 HTML（文字 + 图片 dataUrl 已在 DOM 内）
    const pagesHtml = preview.innerHTML;
    const css = collectCss();
    const doc = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>刊物排版审阅稿</title><style>' + css +
      '\nhtml,body{height:auto;overflow:auto;background:#eef1f5}' +
      '.preview{padding:24px;gap:24px;align-items:center}' +
      '</style></head><body><div class="preview">' + pagesHtml + '</div></body></html>';
    const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
    U.download(blob, '刊物排版审阅稿_' + Date.now() + '.html');
    U.toast('自包含 HTML 已导出（对方双击即可离线审阅）');
  }

  // ---------- 从 URL hash 还原（线上链接用） ----------
  function restoreFromHash() {
    const m = location.hash.match(/#share=([^&]+)/);
    if (!m) return false;
    try {
      const json = lzDecompress(decodeURIComponent(m[1]));
      if (!json) throw new Error('数据解码失败');
      const data = JSON.parse(json);
      if (!data.docs || !data.docs.length) throw new Error('数据内容为空');
      const ok = window.App && App.openArchiveData ? App.openArchiveData(data) : false;
      if (ok) U.toast('已从分享链接还原排版，可审阅');
      return ok;
    } catch (e) {
      console.error('share restore failed', e);
      U.toast('分享链接数据无法还原：' + (e.message || e));
      return false;
    }
  }

  function open() {
    const m = $('shareModal');
    if (!m) return;
    m.hidden = false;
    $('shareInfo').textContent = '生成给他人审阅的链接或文件';
  }
  function close() { const m = $('shareModal'); if (m) m.hidden = true; }

  function bind() {
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('shareClose', close);
    on('btnGenLink', genLink);
    on('btnCopyLink', copyLink);
    on('btnGenHtml', genHtml);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && $('shareModal') && !$('shareModal').hidden) close();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  return { open, close, genLink, genHtml, restoreFromHash, lzCompress, lzDecompress };
})();
window.Share = Share;
