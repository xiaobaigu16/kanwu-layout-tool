/* 分享（v3.8）：PDF 印刷效果预览网页
 *  - buildPreviewHtml()：用 ExportPdf.renderPages() 的逐页 JPEG 生成自包含 HTML
 *  - genHtml()：导出 HTML 文件（长期存档兜底，可放任意静态托管）
 *  - publish()：v3.8 新增——一键上传到匿名静态托管，直接得到别人可打开的 https 链接
 *     实测 litterbox.catbox.moe：支持 CORS 跨域 POST、Content-Type:text/html、
 *     无 Content-Disposition，浏览器直接打开为网页；时效可选 1h/12h/24h/72h。
 *     注意：这是临时托管，到期自动删除，适合临时分享；永久链接需 GitHub Token。
 */
const Share = (() => {
  function $(id) { return document.getElementById(id); }
  const UPLOAD_API = 'https://litterbox.catbox.moe/resources/internals/api.php';

  // 生成自包含预览页 HTML（图片内嵌，离线双击可看，上传后在线可看）
  async function buildPreviewHtml(onProgress) {
    if (!window.App || !App.state.docs.length) throw new Error('当前没有可分享的排版');
    if (typeof ExportPdf === 'undefined' || !ExportPdf.renderPages) {
      throw new Error('预览组件未就绪，请先打开一次 PDF 效果预览');
    }
    if (onProgress) onProgress('正在生成逐页印刷稿…');
    const images = await ExportPdf.renderPages(false);
    const p = App.state.page;
    const cssW = p.w * (96 / 25.4);
    const imgsHtml = images.map((im, i) =>
      '<figure class="pg"><img src="' + im.dataUrl + '" alt="第' + (i + 1) + '页">' +
      '<figcaption>第 ' + (i + 1) + ' / ' + images.length + ' 页</figcaption></figure>'
    ).join('\n');
    const title = (App.state.docs[0] && App.state.docs[0].name ? App.state.docs[0].name.replace(/\.[^.]+$/, '') : '刊物') + ' · PDF 效果预览';
    const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + title.replace(/</g, '&lt;') + '</title><style>' +
      '*{box-sizing:border-box}body{margin:0;background:#2a2e2b;color:#e8ede9;' +
      'font-family:"Microsoft YaHei","PingFang SC",sans-serif}' +
      '.bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;gap:12px;' +
      'padding:10px 18px;background:#1d211e;border-bottom:1px solid #39423b;' +
      'font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,.3)}' +
      '.bar b{color:#8fd6a3}.bar .sp{flex:1}.bar button{background:#2c3a30;color:#cfe8d6;' +
      'border:1px solid #46624e;border-radius:5px;padding:5px 12px;cursor:pointer;font-size:12px}' +
      '.bar button:hover{background:#3a5442}' +
      '.wrap{padding:24px 16px 60px;text-align:center}' +
      '.pg{margin:0 auto 30px;line-height:0}' +
      '.pg img{display:block;margin:0 auto;max-width:none;width:' + cssW + 'px;' +
      'background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.45)}' +
      '.pg figcaption{font-size:12px;color:#9fb0a4;line-height:1.4;padding-top:8px}' +
      '</style></head><body>' +
      '<div class="bar"><b>' + title.replace(/</g, '&lt;') + '</b><span>' + images.length + ' 页 · ' +
      p.w + '×' + p.h + 'mm</span><span class="sp"></span>' +
      '<button onclick="setZ(1)">100%</button><button onclick="setZ(1.4)">放大</button>' +
      '<button onclick="fit()">适应宽度</button></div>' +
      '<div class="wrap" id="wrap">' + imgsHtml + '</div>' +
      '<script>var z=1;function setZ(n){z=n;document.querySelectorAll(".pg img").forEach(function(i){' +
      'i.style.width=' + cssW + '*z+"px"})}function fit(){var w=document.getElementById("wrap").clientWidth-40;' +
      'setZ(Math.max(0.2,Math.min(1.4,w/' + cssW + ')))}fit()<\/script>' +
      '</body></html>';
    return { html, count: images.length };
  }

  async function genHtml() {
    const prog = $('shareProgress');
    try {
      const out = await buildPreviewHtml(msg => { if (prog) prog.textContent = msg; });
      const blob = new Blob([out.html], { type: 'text/html;charset=utf-8' });
      U.download(blob, 'PDF效果预览_' + Date.now() + '.html');
      if (prog) prog.textContent = '已导出 · ' + out.count + ' 页';
      U.toast('已导出 PDF 效果预览网页（' + out.count + ' 页）');
    } catch (e) {
      if (prog) prog.textContent = '';
      console.error(e);
      U.toast('导出失败：' + (e.message || e));
    }
  }

  // v3.8：一键上传到匿名静态托管，返回可直接打开的 https 链接
  async function publish() {
    const prog = $('shareProgress');
    const result = $('publishResult');
    if (result) result.hidden = true;
    try {
      const ttl = ($('publishTtl') && $('publishTtl').value) || '24h';
      const out = await buildPreviewHtml(msg => { if (prog) prog.textContent = msg; });
      if (prog) prog.textContent = '正在上传到公开托管（' + out.count + ' 页）…';
      const form = new FormData();
      form.append('reqtype', 'fileupload');
      form.append('time', ttl);
      form.append('fileToUpload', new Blob([out.html], { type: 'text/html;charset=utf-8' }),
        'preview_' + Date.now() + '.html');
      const resp = await fetch(UPLOAD_API, { method: 'POST', body: form });
      if (!resp.ok) throw new Error('上传失败（HTTP ' + resp.status + '）');
      const url = (await resp.text()).trim();
      if (!/^https?:\/\//.test(url)) throw new Error('上传未返回有效链接：' + url.slice(0, 80));
      if (prog) prog.textContent = '发布成功 · ' + out.count + ' 页 · 有效期 ' + ttl;
      if (result) {
        result.hidden = false;
        const inp = $('publishUrl'); if (inp) inp.value = url;
        const openBtn = $('publishOpen'); if (openBtn) openBtn.onclick = () => window.open(url, '_blank', 'noopener');
        const copyBtn = $('publishCopy');
        if (copyBtn) copyBtn.onclick = async () => {
          try { await navigator.clipboard.writeText(url); U.toast('链接已复制'); }
          catch (e) {
            if (inp) { inp.select(); document.execCommand('copy'); U.toast('链接已复制'); }
          }
        };
      }
      U.toast('已发布公开链接（有效期 ' + ttl + '），可直接发给他人打开');
    } catch (e) {
      if (prog) prog.textContent = '';
      console.error(e);
      U.toast('发布失败：' + (e.message || e) + '（可改用「导出 HTML 文件」）');
    }
  }

  function open() {
    const m = $('shareModal');
    if (!m) return;
    m.hidden = false;
    $('shareInfo').textContent = '一键发布公开链接，或导出 HTML 文件长期存档';
    const prog = $('shareProgress'); if (prog) prog.textContent = '';
    const result = $('publishResult'); if (result) result.hidden = true;
  }
  function close() { const m = $('shareModal'); if (m) m.hidden = true; }

  function bind() {
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('shareClose', close);
    on('btnGenHtml', genHtml);
    on('btnPublish', publish);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && $('shareModal') && !$('shareModal').hidden) close();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  return { open, close, genHtml, publish };
})();
window.Share = Share;
