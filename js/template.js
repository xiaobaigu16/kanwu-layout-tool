/* 模板预设系统（v3.2 新增）
 *
 * 把《2025年度雨露肝霖白皮书》实测版式全部抽成一份「模板预设」数据，
 * 界面上可图形化编辑、保存为多个命名预设、导入导出。
 * 颜色/几何/字号等以 CSS 变量注入到预览页；导出 Word/PDF 时也统一从这里取值。
 *
 * 预设存储：localStorage（键 kanwu_presets_v3_2）。archive（.json 存档）里
 * 会内嵌当前预设的完整快照，保证打开存档即还原当时的版式外观。
 */
const Template = (() => {
  const STORE_KEY = 'kanwu_presets_v3_2';

  /* ---------- 默认预设：雨露肝霖白皮书（2026-11-09 实测确认） ---------- */
  function defaultTemplate() {
    return {
      name: '雨露肝霖白皮书（默认）',
      page: {
        w: 216, h: 303, mt: 15, mb: 35, ml: 22.9, mr: 23.5,
        cols: 2, lineH: 1.64, hdr: '', ftr: '', showNum: true
      },
      colGap: 12.2,        // 双栏栏间距（mm）
      fullInset: 10.9,     // 通栏区相对双栏左边界向左外扩（mm）：22.9-12=10.9
      // 三色：主绿 / 竖排标签底 / 目录标题块
      colors: {
        primary: '#008000',   // 主绿：标题/小标题/编号重点句/编者按段首/目录分组
        labelBg: '#58A830',   // 竖排栏目标签底
        tocBlock: '#187838',  // 目录标题块
        bodyText: '#222222',  // 正文/图注文字
        cite: '#7A8492'       // 文献来源灰字
      },
      fonts: {
        // 衬线（正文/导语/图注/目录正文）；无衬线（标题/小标题/标签/目录标题）
        serif: 'SimSun, "Songti SC", "Noto Serif CJK SC", serif',
        sans: '"Microsoft YaHei", "PingFang SC", sans-serif'
      },
      // 竖排栏目标签
      tab: { enabled: true, x: 3, w: 8.9, h: 38.1, radius: 8, textColor: '#ffffff', everyPage: true },
      // 二维码（文章首页右上，与标题同水平带）
      qr: { enabled: true, size: 20, x: 21, y: 24, bandWithTitle: true, squareAsQr: true },
      // 正文：宋体 11.5pt / 行距 1.64 / 首行缩进 2 字 / 两端对齐 / 不加粗
      body: { pt: 11.5, lineH: 1.64, firstLineIndent: 2, align: 'justify', bold: false },
      // 图注/表题：9pt 小字加粗居中黑字，必须独立成块
      caption: { pt: 9, bold: true, align: 'center', color: '#222222', maxLen: 60 },
      // 文章标题：15pt 粗体左对齐 + 双方块图标
      title: { pt: 15, bold: true, align: 'left', icon: true, color: '#008000' },
      // 目录：单栏、深绿标题块、三位补零
      toc: { titleColor: '#187838', lineH: 1.64, pageNumPad: 3 },
      // 各类型在 Word/PDF 里的精确字号（pt），与 CSS 一致；不在 UI 暴露，可在 JSON 里微调
      typeStyles: {
        'art-title': { pt: 15, bold: true, color: '#008000' },
        lead: { pt: 11.5, bold: false, color: '#222222' },
        cite: { pt: 8.5, bold: false, color: '#7A8492' },
        'label-head': { pt: 10.5, bold: true, color: '#008000' },
        highlight: { pt: 11, bold: true, color: '#008000' },
        h1: { pt: 13, bold: true, color: '#008000' },
        h2: { pt: 11, bold: true, color: '#008000' },
        h3: { pt: 10, bold: true, color: '#008000' },
        body: { pt: 11.5, bold: false, color: '#222222' },
        caption: { pt: 9, bold: true, color: '#222222' }
      },
      // 导入套版规则（参数化，方便换刊物）
      import: {
        discardWordStyles: true,  // 丢弃 Word 自带 w:sz/color/rFonts/b
        mergeEditorNote: true,   // 把独立的「编者按」短词段与正文合并成通栏 lead
        squareAsQr: true,        // 前几张方形图识别为二维码
        refAlignThreshold: 0.85  // 几乎纯拉丁段（参考文献等）才改左对齐的阈值
      },
      previewScale: 0.72,
      previewOptions: [0.5, 0.72, 1, 1.25]
    };
  }

  /* ---------- 颜色工具：由主色派生深绿/浅绿 ---------- */
  function clamp255(x) { return Math.max(0, Math.min(255, Math.round(x))); }
  function hexToRgb(h) {
    h = (h || '').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => clamp255(v).toString(16).padStart(2, '0')).join('');
  }
  // pct > 0 变暗，pct < 0 变亮（向白靠拢）
  function shade(hex, pct) {
    const [r, g, b] = hexToRgb(hex);
    const t = pct < 0 ? 255 : 0;
    const p = Math.abs(pct);
    return rgbToHex(r + (t - r) * p, g + (t - g) * p, b + (t - b) * p);
  }
  function hexNoHash(hex) { return (hex || '').replace('#', '').toUpperCase(); }

  /* ---------- 派生色（深绿 / 浅绿底 / 浅绿线） ---------- */
  function derivedColors(t) {
    const p = t.colors.primary;
    return {
      primary: p,
      dark: shade(p, 0.18),       // 主色加深 18%（hover/链接）
      bg: shade(p, -0.88),        // 主色极浅（浅绿背景）
      line: shade(p, -0.70),      // 主色浅（浅绿线）
      labelBg: t.colors.labelBg,
      tocBlock: t.colors.tocBlock,
      bodyText: t.colors.bodyText,
      cite: t.colors.cite
    };
  }

  /* ---------- 路径读写（data-tpl="colors.primary" 等） ---------- */
  function getByPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setByPath(obj, path, val) {
    const ks = path.split('.');
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) {
      if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {};
      o = o[ks[i]];
    }
    o[ks[ks.length - 1]] = val;
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------- 预设存储 ---------- */
  function loadAll() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) return arr;
      }
    } catch (e) { /* 忽略损坏数据 */ }
    // 首次：写入默认预设
    const def = defaultTemplate();
    const arr = [def];
    try { localStorage.setItem(STORE_KEY, JSON.stringify(arr)); } catch (e) {}
    return arr;
  }
  function saveAll(arr) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(arr)); } catch (e) {}
  }

  return {
    defaultTemplate, shade, hexNoHash, derivedColors,
    getByPath, setByPath, clone, loadAll, saveAll, STORE_KEY
  };
})();
