/* 上传解析：zip/docx -> 文档模型
 * 支持：
 *  - .docx 直接解析（段落/标题/图片/表格文本化/对齐/加粗斜体上下标…）
 *  - .zip 递归解压，内部所有 .docx 与嵌套 .zip 一并提取
 *  - 多文档按文件名序号排序（由 app.sortDocs 统一排序，见 app.js）
 */
const Parser = (() => {

  // 命名空间无关的标签查找（避免 w:/a:/pic: 前缀差异），统一返回数组便于遍历
  function all(el, local) {
    const nl = el.getElementsByTagNameNS ? el.getElementsByTagNameNS('*', local) : el.getElementsByTagName(local);
    return Array.from(nl);
  }

  async function handleFiles(fileList) {
    const docs = [];
    for (const file of fileList) {
      const name = file.name || '';
      if (/\.zip$/i.test(name)) {
        const inner = await extractDocsFromZip(file);
        docs.push(...inner);
      } else if (/\.docx$/i.test(name)) {
        const d = await parseDocxFile(file, name);
        if (d) docs.push(d);
      } else {
        U.toast('已忽略非 zip/docx 文件：' + name);
      }
      // 每个文件之间让出主线程，避免多文件/大 zip 时页面长时间无响应
      await new Promise(r => setTimeout(r, 0));
    }
    return docs;
  }

  async function extractDocsFromZip(file) {
    const zip = await JSZip.loadAsync(file);
    const out = [];
    await walkZip(zip, out);
    return out;
  }

  // 递归遍历 zip：先按文件名排序解出的 docx，再递归处理内嵌 zip（保证稳定顺序）
  async function walkZip(zip, out) {
    const entries = Object.keys(zip.files);
    const docxs = entries.filter(e => /\.docx$/i.test(e) && !zip.files[e].dir)
                         .sort((a, b) => U.compareSort(a, b));
    for (const e of docxs) {
      const name = e.split('/').pop();
      const d = await parseDocxFile(await zip.files[e].async('arraybuffer'), name);
      if (d) out.push(d);
    }
    const zips = entries.filter(e => /\.zip$/i.test(e) && !zip.files[e].dir);
    for (const e of zips) {
      const sub = await JSZip.loadAsync(await zip.files[e].async('blob'));
      await walkZip(sub, out);
    }
  }

  function parseRels(xml) {
    const map = {};
    if (!xml) return map;
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    all(doc, 'Relationship').forEach(r => {
      map[r.getAttribute('Id')] = r.getAttribute('Target');
    });
    return map;
  }

  // 将 rels 的 Target（相对 word/）解析为 zip 内真实路径，并归一化 .. / .
  function resolveMediaPath(target) {
    let p = target || '';
    if (p.startsWith('/')) p = p.slice(1);
    else p = 'word/' + p.replace(/^\.\//, '');
    const parts = p.split('/');
    const stack = [];
    for (const seg of parts) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') stack.pop();
      else stack.push(seg);
    }
    return stack.join('/');
  }

  function imgMime(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml'
    };
    return map[ext] || 'image/png';
  }

  // 超大内嵌图片降采样：docx 里的高清截图动辄几 MB，转 base64 + 解码会明显拖慢界面。
  // 只处理 >1.2MB 且边长 >2000px 的图；普通图片一字不动，保证内容保真。
  async function shrinkDataUrl(dataUrl) {
    if (!dataUrl || dataUrl.length < 1200000) return dataUrl;
    if (typeof document === 'undefined' || !document.createElement) return dataUrl;
    return new Promise(res => {
      let done = false;
      const finish = v => { if (!done) { done = true; res(v); } };
      const timer = setTimeout(() => finish(dataUrl), 1500); // 环境不触发 load 时兜底
      try {
        const im = new Image();
        im.onload = () => {
          try {
            if (im.naturalWidth <= 2000 && im.naturalHeight <= 2000) return finish(dataUrl);
            const k = 2000 / Math.max(im.naturalWidth, im.naturalHeight);
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(im.naturalWidth * k));
            c.height = Math.max(1, Math.round(im.naturalHeight * k));
            const cx = c.getContext('2d');
            if (!cx) return finish(dataUrl);
            cx.drawImage(im, 0, 0, c.width, c.height);
            finish(c.toDataURL('image/jpeg', 0.88));
          } catch (e) { finish(dataUrl); }
          clearTimeout(timer);
        };
        im.onerror = () => { clearTimeout(timer); finish(dataUrl); };
        im.src = dataUrl;
      } catch (e) { clearTimeout(timer); finish(dataUrl); }
    });
  }

  // 读取图片尺寸（用于识别二维码）；带超时兜底，某些环境不触发 load 也不会卡住
  function imageSize(dataUrl) {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return Promise.resolve(null);
    return new Promise(res => {
      let done = false;
      const finish = v => { if (!done) { done = true; res(v); } };
      const timer = setTimeout(() => finish(null), 1200);
      try {
        const im = new Image();
        im.onload = () => { clearTimeout(timer); finish({ w: im.naturalWidth, h: im.naturalHeight }); };
        im.onerror = () => { clearTimeout(timer); finish(null); };
        im.src = dataUrl;
      } catch (e) { clearTimeout(timer); finish(null); }
    });
  }

  // 成品里二维码是「缩小后放在标题右侧」的小方图；导入稿件常把它当正文大图插进来。
  // 识别前几个块里接近正方形的图片 → 设为 doc.qr 并从正文移除，避免铺满整页。
  async function extractQrcode(doc) {
    if (!doc || !doc.blocks || !doc.blocks.length) return doc;
    const limit = Math.min(5, doc.blocks.length);
    for (let i = 0; i < limit; i++) {
      const b = doc.blocks[i];
      if (b.type !== 'image' || !b.src) continue;
      const sz = await imageSize(b.src);
      if (!sz || !sz.w || !sz.h) continue;
      const ratio = sz.w / sz.h;
      if (ratio >= 0.85 && ratio <= 1.18) {
        doc.qr = b.src;
        doc.blocks.splice(i, 1);
        break;
      }
    }
    return doc;
  }

  async function parseDocxFile(blob, name) {
    try {
      const zip = await JSZip.loadAsync(blob);
      const docFile = zip.file('word/document.xml');
      if (!docFile) throw new Error('缺少 word/document.xml');
      const docXml = await docFile.async('string');
      const relsXml = await (zip.file('word/_rels/document.xml.rels')?.async('string') || '');
      const rels = parseRels(relsXml);
      // 只把正文真正引用的图片转成 base64：很多 docx 的页眉/未引用素材体积很大，
      // 全量转换会让上传卡很久
      const usedRids = new Set();
      const ridRe = /r:(?:embed|link|id)="([^"]+)"/g;
      let rm;
      while ((rm = ridRe.exec(docXml))) usedRids.add(rm[1]);
      const media = {};
      for (const rid in rels) {
        if (!usedRids.has(rid)) continue;
        const mPath = resolveMediaPath(rels[rid]);
        const f = zip.file(mPath);
        if (f) {
          const mime = imgMime(rels[rid]);
          const raw = 'data:' + mime + ';base64,' + await f.async('base64');
          media[rid] = await shrinkDataUrl(raw);
        }
      }
      const blocks = parseDocument(docXml, media);
      const doc = { id: U.uid('doc'), name, blocks };
      return await extractQrcode(doc);
    } catch (e) {
      U.toast('解析失败：' + name);
      console.error(e);
      return null;
    }
  }

  function styleOf(styleVal) {
    if (!styleVal) return 'body';
    const v = styleVal.toLowerCase();
    if (v.includes('heading1') || v === 'title') return 'h1';
    if (v.includes('heading2')) return 'h2';
    if (v.includes('heading3')) return 'h3';
    return 'body';
  }

  function jcToAlign(v) {
    if (!v) return null;
    v = v.toLowerCase();
    if (v === 'center') return 'center';
    if (v === 'right' || v === 'end') return 'right';
    if (v === 'both' || v === 'distribute') return 'justify';
    return 'left';
  }

  // 导入时一律**丢弃 Word 自带的字号 / 颜色 / 字体 / 加粗**，只留文字与语义格式
  // （斜体、下划线、上下标）。原因：预览按 0.72 缩放，模板字号是 calc(10.6pt*--fs)，
  // 而 Word 的 <span style="font-size:12pt"> 不参与缩放，会让导入正文凭空放大 1.67 倍；
  // 且它是最内层样式，工具栏再往外包 span 也改不动。剥掉后字号/字体/加粗全部由刊物模板接管。
  function runToHtml(r) {
    const rpr = all(r, 'rPr')[0];
    let italic = false, underline = false, vert = null;
    if (rpr) {
      const i = all(rpr, 'i')[0];
      italic = i && i.getAttribute('w:val') !== '0';
      const u = all(rpr, 'u')[0];
      underline = u && u.getAttribute('w:val') && u.getAttribute('w:val') !== 'none';
      const va = all(rpr, 'vertAlign')[0];
      if (va) vert = va.getAttribute('w:val');
    }
    let text = '';
    for (const child of r.childNodes) {
      const tag = child.nodeName.split(':').pop();
      if (tag === 't') text += U.escapeHtml(child.textContent);
      else if (tag === 'tab') text += '&nbsp;&nbsp;&nbsp;&nbsp;';
      else if (tag === 'br') text += '<br/>';
    }
    if (!text) return '';
    let h = text;
    if (vert === 'superscript') h = '<sup>' + h + '</sup>';
    else if (vert === 'subscript') h = '<sub>' + h + '</sub>';
    let pre = '', post = '';
    if (italic) { pre += '<i>'; post = '</i>' + post; }
    if (underline) { pre += '<u>'; post = '</u>' + post; }
    return pre + h + post;
  }

  function parseDocument(xml, media) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const body = all(doc, 'body')[0];
    if (!body) return [];
    const blocks = [];
    for (const node of body.childNodes) {
      const tag = node.nodeName.split(':').pop();
      if (tag === 'p') {
        parseParagraph(node, media, blocks);
      } else if (tag === 'tbl') {
        parseTable(node, blocks);
      }
      // 其它元素（sectPr 等）忽略
    }
    return blocks;
  }

  // 表格：扁平化为一个正文块（行内单元格用「｜」分隔，行间用换行），避免静默丢失内容
  function parseTable(tbl, blocks) {
    const rows = all(tbl, 'tr');
    const lines = [];
    for (const tr of rows) {
      const cells = all(tr, 'tc');
      const parts = [];
      for (const tc of cells) {
        let s = '';
        for (const p of all(tc, 'p')) {
          for (const r of all(p, 'r')) {
            for (const t of all(r, 't')) s += t.textContent;
          }
          s += '<br>';
        }
        parts.push(s.replace(/<br>$/, ''));
      }
      lines.push(parts.map(U.escapeHtml).join(' ｜ '));
    }
    const html = lines.join('<br>');
    if (html.trim()) {
      blocks.push({ id: U.uid('blk'), type: 'body', html, align: 'left',
                    pageBreakBefore: false, lineHeight: null });
    }
  }

  function parseParagraph(p, media, blocks) {
    const ppr = all(p, 'pPr')[0];
    let style = 'body';
    if (ppr) {
      const ps = all(ppr, 'pStyle')[0];
      if (ps) style = styleOf(ps.getAttribute('w:val'));
    }
    let align = 'left';
    if (ppr) {
      const jc = all(ppr, 'jc')[0];
      if (jc) { const a = jcToAlign(jc.getAttribute('w:val')); if (a) align = a; }
    }

    // 收集段落内 token：文字片段与图片，按出现顺序交错
    const tokens = [];
    for (const child of p.childNodes) {
      const tag = child.nodeName.split(':').pop();
      if (tag === 'r') {
        const drawing = all(child, 'drawing')[0];
        if (drawing) {
          const blip = all(drawing, 'blip')[0];
          if (blip) {
            const rid = blip.getAttribute('r:embed');
            if (rid && media[rid]) tokens.push({ img: media[rid] });
          }
        } else {
          const t = runToHtml(child);
          if (t) {
            const last = tokens[tokens.length - 1];
            if (last && last.text != null) last.text += t;
            else tokens.push({ text: t });
          }
        }
      }
    }

    let buf = '';
    const flush = () => {
      if (buf.trim() !== '') {
        blocks.push({ id: U.uid('blk'), type: style, html: buf, align,
                      pageBreakBefore: false, lineHeight: null });
        buf = '';
      }
    };
    for (const tk of tokens) {
      if (tk.img) { flush(); blocks.push({ id: U.uid('blk'), type: 'image', src: tk.img, caption: '', align: 'center' }); }
      else buf += tk.text;
    }
    flush();
  }

  // ---------- 导入后自动套用刊物模板 ----------
  // 复刻《2025年度雨露肝霖白皮书》内页：绿色标题+方块图标 / 通栏「编者按」导语 /
  // 绿色小标题 / 绿色编号重点句 / 宋体首行缩进双栏正文 / 贴边竖排栏目标签 / 右上二维码
  const LEAD_WORDS = ['编者按', '导语', '导读', '前言', '引言', '肝素君有话说'];
  // v3.2：语义小标题清单（文档 04 章「研究背景 / 方法 / 结果 / 结论」显式识别，
  // 不再靠「长度 ≤14 且无标点」猜）。命中即绿色小标题，白皮书成品的段落层次。
  const SECTION_WORDS = [
    '研究背景', '研究方法', '研究结果', '研究结论', '研究亮点', '研究设计', '研究对象',
    '研究目的', '资料与方法', '对象与方法', '基线特征', '统计学方法', '临床资料',
    '诊疗经过', '病例资料', '病例特点', '病例简介', '病例摘要', '专家点评', '核心提示',
    '关键信息', '主要发现', '临床意义', '指南要点', '背景', '目的', '方法', '结果',
    '结论', '讨论', '小结', '摘要', '要点', '导读', '点评', '研究流程', '纳入标准',
    '排除标准', '随访结果', '安全性', '疗效分析', '参考文献'
  ];
  // 正文/双栏块的集合：用于判定「首页通栏区在哪里结束」
  const BODY_TYPES = ['body', 'label-head', 'highlight', 'h1', 'h2', 'h3', 'caption', 'references'];
  const ALIGN_OF = {
    'art-title': 'left', 'lead': 'justify', 'cite-box': 'left',
    'label-head': 'left', 'highlight': 'left', 'body': 'justify',
    references: 'left', h1: 'left', h2: 'left', h3: 'left', caption: 'center'
  };

  function plainText(html) {
    const d = new DOMParser().parseFromString(html || '', 'text/html');
    return (d.body.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // 标注文字：图注 / 表题 / 数据来源 / 脚注。成品里是「小字加粗居中」，必须与正文分开，
  // 之前没有这条规则，「图 1. HBsAg 清除率森林图」被判成 body，于是标注和正文混在一起。
  // 只认 60 字以内的短句，避免把正文里提到「图 1」的长段误判成图注。
  function isCaption(txt) {
    if (txt.length > 60 || txt.length < 2) return false;
    if (/^(图|表|图表|附图|附表)\s*[\d一二三四五六七八九十]+[\s.、．:：]/.test(txt)) return true;
    if (/^(Figure|Fig\.?|Table)\s*\d+/i.test(txt)) return true;
    if (/^(注|数据来源|资料来源|来源|说明)\s*[:：]/.test(txt)) return true;
    if (/(森林图|流程图|示意图|趋势图|生存曲线|瀑布图|柱状图)$/.test(txt)) return true;
    return false;
  }

  const LEAD_COLOR = '#008000';   // 白皮书主绿

  // 把「编者按：」这类段首词包成绿色加粗（只加 span 标签，文字一字不改）
  function wrapLeadKeyword(html) {
    const m = (html || '').match(/^(\s*)(编者按|导语|导读|前言|引言|肝素君有话说)\s*[:：]/);
    if (!m) return html;
    const inner = m[0].slice(m[1].length);
    // 同时给 inline style：Word 导出靠它把段首词也变成绿色加粗
    return m[1] + '<span class="lead-kw" style="color:' + LEAD_COLOR + ';font-weight:700">' +
      inner + '</span>' + html.slice(m[0].length);
  }

  // 独立成段的短词（「编者按」「导语」…），可作为通栏导语的段首标签
  function leadKeyword(text) {
    const m = (text || '').trim().match(/^(编者按|导语|导读|前言|引言|肝素君有话说)\s*[:：]?$/);
    return m ? m[1] : null;
  }

  // 成品里「编者按」是通栏长段落的段首，不是独立小标题。
  // 导入稿件常把它写成单独一段、正文另起一段；这里把两段合并成一个通栏 lead 块，
  // 段落结构改变但文字内容一字不删改（短词原样保留，仅在其后接正文）。
  function mergeLeadBlocks(doc, texts) {
    const blocks = doc.blocks;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].type === 'image' || !leadKeyword(texts[i])) continue;
      let j = i + 1;
      while (j < blocks.length && (blocks[j].type === 'image' || !texts[j])) j++;
      if (j >= blocks.length || texts[j].length < 20) continue;
      const word = (texts[i] || '').trim();
      // 原文已有冒号就原样；没有则补一个全角冒号作为段首标识（唯一新增的标点）
      const sep = /[:：]$/.test(word) ? '' : '：';
      blocks[i].html = '<span class="lead-kw" style="color:' + LEAD_COLOR + ';font-weight:700">' +
        U.escapeHtml(word) + '</span>' + U.escapeHtml(sep) + blocks[j].html;
      blocks[i].type = 'lead';
      blocks[i].align = 'justify';
      blocks[i]._mergedLead = true;
      blocks.splice(j, 1);
      texts.splice(j, 1);
      texts[i] = plainText(blocks[i].html);
      return true;   // 每篇只合并一处
    }
    return false;
  }

  // v3.3：编者按常有多段（问题整理 image2 标注「这一段也是属于编者按，要放一栏」）。
  // 逐块识别完成后，把首个 lead 之后、第一张图片之前的连续正文段也标为 lead；
  // 遇到小标题 / 图注 / 参考文献 / 来源等结构块即停，最多扩展 4 段，
  // 避免把双栏正文误吞进通栏区。文字内容一字不改，只改块类型与通栏标记。
  function extendLead(doc) {
    const bs = doc.blocks;
    const li = bs.findIndex(b => b.type === 'lead');
    if (li < 0) return;
    const img = bs.findIndex(b => b.type === 'image');
    const stop = img >= 0 ? img : bs.length;
    let added = 0;
    for (let k = li + 1; k < stop && added < 4; k++) {
      const b = bs[k];
      if (b.type === 'lead') continue;
      if (b.type !== 'body') break;
      const t = plainText(b.html);
      if (!t || t.length < 12) break;
      b.type = 'lead'; b.align = 'justify'; b.recog = 'ok';
      b._mergedLead = true; b.full = true;
      added++;
    }
  }

  // 从文件名猜栏目名：[前沿速递] 01_前沿速递.docx → 前沿速递；02_指南解读.docx → 指南解读
  function guessColumnName(name) {
    const base = (name || '').replace(/\.[^.]+$/, '');
    const m = base.match(/[【\[（(]([^】\]）)]{1,12})[】\]）)]/);
    if (m) return m[1].trim();
    const b2 = base.replace(/^\s*\d+\s*[._、\-—\s]*/, '').replace(/[_]+/g, '').trim();
    // 兜底只取连续中文片段，避免把 test_导入样例 这类文件名里的英文也塞进竖排标签
    const cn = b2.match(/[\u4e00-\u9fa5]{2,8}/);
    return cn ? cn[0] : '';
  }

  // v3.3 三级栏目分类：一级 6 项（可在界面新增/删除）、二级会议、三级主题。
  // AASLD / EASL / APASL 一律归入「会议撷萃」（问题整理第 4 条）。
  const L1_LIST = ['期刊导读', '数据阅独', '会议撷萃', '新药进展', '名家访谈', '项目进展'];
  const CONF_L2 = ['APASL', 'EASL', 'AASLD', '第十三届全国疑难及重症肝病大会'];
  const L3_LIST = ['慢乙肝治疗相关', '慢乙肝合并脂肪肝相关', '慢乙肝疾病进展相关',
                   '慢乙肝核苷停药相关', '慢乙肝治疗及疗效预测相关'];
  const TOPIC_RULES = [
    ['合并脂肪肝', '慢乙肝合并脂肪肝相关'], ['疾病进展', '慢乙肝疾病进展相关'],
    ['核苷停药', '慢乙肝核苷停药相关'], ['疗效预测', '慢乙肝治疗及疗效预测相关'],
    ['治疗', '慢乙肝治疗相关']
  ];
  function classifyDoc(name, texts) {
    const head = (name || '') + ' ' + (texts || []).slice(0, 4).join(' ');
    const up = head.toUpperCase();
    const conf = up.match(/APASL|EASL|AASLD/);
    let cat1 = '', cat2 = '', cat3 = '';
    if (conf) { cat1 = '会议撷萃'; cat2 = conf[0]; }
    // 一级目录优先按 6 个标准项关键词命中，不能把「期刊导读病例发表」这类
    // 从文件名截出来的片段当成自定义栏目（否则配色与目录分组都会跑偏）
    if (!cat1) {
      const hit = L1_LIST.find(k => head.indexOf(k) >= 0);
      if (hit) cat1 = hit;
    }
    if (!cat1) {
      if (/年会|大会|会议|撷萃|摘要|壁报|口头报告/i.test(head)) cat1 = '会议撷萃';
      else if (/新药|获批|上市|适应症|III期|临床试验/i.test(head)) cat1 = '新药进展';
      else if (/访谈|专访|对话|教授访谈/i.test(head)) cat1 = '名家访谈';
      else if (/项目|珠峰|绿洲|萌芽|星光计划|临床治愈/i.test(head)) cat1 = '项目进展';
      else if (/数据|流行|年鉴|统计|患病率|发病率/i.test(head)) cat1 = '数据阅独';
    }
    if (!cat1) cat1 = '期刊导读';   // 兜底：始终落在 6 个标准一级目录内
    for (const [kw, v] of TOPIC_RULES) {
      if (head.indexOf(kw) >= 0) { cat3 = v; break; }
    }
    return { cat1, cat2, cat3, columnName: cat1 };
  }

  // v3.2：语义小标题显式识别（白皮书成品的绿色小标题，如「研究方法：」「研究结论：」）。
  // 允许词后带全角/半角冒号、允许「一、研究方法」这类前缀，但整句必须是短词组，
  // 不能把「研究结果显示 HBsAg 清除率显著提高」这种正文误判成小标题。
  function isSectionHead(txt) {
    const t = (txt || '').trim();
    if (!t || t.length > 16) return false;
    const bare = t.replace(/^[一二三四五六七八九十]+[、.．]\s*/, '')
                 .replace(/\s*[:：]$/, '').trim();
    if (!bare || bare.length > 12) return false;
    return SECTION_WORDS.includes(bare) || SECTION_WORDS.includes(t.replace(/\s*[:：]$/, '').trim());
  }

  // v3.4：参考文献条目识别（文档 04/05 章）。数字编号开头 + 文献特征（年份 / et al / doi /
  // 期刊名 / 网址 / 中文著录词）。与「绿色编号重点句」区分：重点句不含这些文献特征。
  // 放宽：允许 [1] / (1) / 「1 Wang X…」无分隔符等真实稿件常见写法（v3.3 漏判的主因）。
  // 收紧特征词：中文只认著录专用词（杂志 / 学报 / 期刊 / 出版社），
  // 不用「指南 / 共识 / 中华」——否则「1. 新版指南进一步放宽…」这类绿色编号重点句
  // 会被误判成 references、抽到页底，正文反而缺句（真实稿件高频踩坑）。
  // 中文文献缺著录词时通常由下面的「参考文献标题结构判定」兜底收走，不会漏。
  function isReference(txt) {
    const t = (txt || '').trim();
    if (!t) return false;
    const numbered = /^\s*[\[［(（]?\d{1,3}[\]］)）]?\s*[.、．]?\s*\S/.test(t);
    if (!numbered) return false;
    return /et\s*al|doi\s*[:：]|https?:\/\/|PMID|\b(19|20)\d{2}\b|[\[［][JM][\]］]/i.test(t) ||
           /杂志|学报|期刊|出版社|Hepatology|Journal|Lancet|Gastro|Gut\b|JAMA|NEJM|Clinical|Medicine/i.test(t);
  }

  // v3.4 P4 结构判定：真实稿件的参考文献常「无编号」「1 后无点」「作者名开头」，
  // 单条特征匹配必然漏判，漏判的编号段会落到 highlight 留在双栏里（image7 现象）。
  // 以「参考文献 / References」小标题为锚点，之后到文末的连续文本块统一标为 references，
  // 交给 app.js 的页底文献带收走。文字一字不改，只改块类型；图片块跳过。
  function markReferenceZone(doc) {
    const bs = doc.blocks;
    const texts = bs.map(b => (b.type === 'image' ? '' : plainText(b.html)));
    const anchor = bs.findIndex((b, i) =>
      b.type !== 'image' && b.type !== 'art-title' &&
      /^(?:主要|部分|附|参考)?\s*(参考文献|参考资料|References?)\s*[:：]?$/i.test(texts[i]));
    if (anchor < 0) return;
    let seen = false;
    for (let i = anchor + 1; i < bs.length; i++) {
      const b = bs[i];
      if (b.type === 'image') continue;         // 图片不进文献带
      const t = texts[i];
      if (!t) continue;                          // 空块跳过
      if (/^(编者按|导语|结语|致谢|作者简介|通讯作者)/.test(t)) break;  // 遇到新结构即停
      b.type = 'references'; b.align = 'left'; b.recog = 'ok';
      if (!b.fullLocked) delete b.full;         // 由 app.js isRef 判定收进页底带
      seen = true;
    }
    // 锚点标题本身也标记，便于 app.js isRefHead 一并归入页底带
    if (seen) { bs[anchor].type = 'label-head'; bs[anchor].align = 'left'; bs[anchor].recog = 'ok'; }
  }

  // 参考文献块常把多条文献写在一个段落里用 <br> 分隔。按「<br> 后紧跟编号」拆成独立块，
  // 便于连续编号检查与悬挂缩进；文字与 inline 标记一字不删改。
  function splitRefBlock(html) {
    const parts = (html || '').split(/<br\s*\/?>/i);
    const out = [];
    parts.forEach(p => {
      const s = p.trim();
      if (!s) return;
      const bare = plainText(s);
      if (/^\d+\s*[.、．]/.test(bare) && out.length) out.push(s);
      else if (out.length) out[out.length - 1] += '<br>' + s;
      else out.push(s);
    });
    return out.length ? out : [html || ''];
  }

  // 把识别出的 references 块按编号拆开，并保留块的基础属性
  function explodeReferences(doc) {
    const bs = doc.blocks;
    const next = [];
    bs.forEach(b => {
      if (b.type !== 'references') { next.push(b); return; }
      splitRefBlock(b.html).forEach((html, k) => {
        const nb = Object.assign({}, b, {
          id: k === 0 ? b.id : U.uid('blk'), html,
          type: 'references', align: 'left', recog: 'ok', full: false
        });
        next.push(nb);
      });
    });
    doc.blocks = next;
  }

  // v3.2：首页通栏「显式槽位」（施工单第 3 条 / 文档 05 章）。
  // 成品首页顺序固定为：标题 → 二维码(页面装饰) → 编者按 → 文献截图 → 来源 → 之后才双栏。
  // 旧版靠「遇到的第一张图」打 full 标记，稿子里先出现小图/装饰图就把文献截图挤进双栏，
  // 于是「文献截图跑到下面去了」。这里改为按结构显式挑出并排到数组最前，其余块保持相对顺序。
  function layoutFrontMatter(doc) {
    const bs = doc.blocks;
    const bodyStart = bs.findIndex(b => BODY_TYPES.includes(b.type));
    const firstBody = bodyStart < 0 ? bs.length : bodyStart;
    // 首页文献截图 = 出现在正文开始之前的第一张图（二维码已在 extractQrcode 里移除）
    const imgIdx = bs.findIndex((b, i) => b.type === 'image' && i < firstBody);
    const idx = {
      title: bs.findIndex(b => b.type === 'art-title'),
      lead: bs.findIndex(b => b.type === 'lead'),
      img: imgIdx,
      cite: bs.findIndex(b => b.type === 'cite-box')
    };
    const front = [];
    const add = b => { if (b && !front.includes(b)) front.push(b); };
    if (idx.title >= 0) add(bs[idx.title]);
    // v3.3：收集全部导语块（旧版只取第一个 lead，第二段被拆进双栏）
    bs.forEach(b => { if (b.type === 'lead') add(b); });
    if (idx.img >= 0) {
      add(bs[idx.img]);
      // v3.4：图注已是独立 caption 块，紧随首页通栏图片一并纳入 front 槽位，
      // 否则图片在通栏区、图注被留在双栏区，会被质检判「图注脱离」且视觉分离。
      const capAfter = bs[idx.img + 1];
      if (capAfter && capAfter.type === 'caption') add(capAfter);
    }
    if (idx.cite >= 0) add(bs[idx.cite]);
    // 用户手动锁定的通栏/分栏块不覆盖
    front.forEach(b => {
      if (!b.fullLocked) b.full = true;
      if (!b.recog) b.recog = 'ok';
    });
    // v3.3 关键修复：不再给未入选的块写死 b.full=false。
    // 旧写法让「识别结果里改类型」完全失效（blockFull 优先读 b.full，改 type 不重排）。
    bs.forEach(b => {
      if (!front.includes(b) && !b.fullLocked && b.full != null && b.type !== 'image') delete b.full;
    });
    // 重排：通栏槽位提到最前，其余保持原有相对顺序（不改动文字内容）
    doc.blocks = front.concat(bs.filter(b => !front.includes(b)));
    doc.frontMatterCount = front.length;
  }

  function applyTemplate(docs, opts) {
    const reset = !!(opts && opts.reset);
    docs.forEach(doc => {
      // 一次性算好每段纯文本，避免对每个块反复解析 DOM
      const texts = doc.blocks.map(b => (b.type === 'image' ? '' : plainText(b.html)));
      // v3.3：三级栏目分类（含 AASLD/EASL/APASL 自动归入「会议撷萃」）
      const cls = classifyDoc(doc.name, texts);
      if (reset || !doc.cat1) {
        doc.cat1 = cls.cat1; doc.cat2 = cls.cat2; doc.cat3 = cls.cat3;
        if (reset || !doc.columnName) doc.columnName = cls.columnName;
      }
      if (!doc.cols) doc.cols = 2;
      if (doc.qr == null) doc.qr = '';

      // ① 先把「编者按」短词段与紧随其后的正文段合并成通栏导语
      if (!doc.blocks.some(b => b._mergedLead)) mergeLeadBlocks(doc, texts);

      let firstText = -1;
      texts.forEach((t, i) => { if (t && firstText < 0) firstText = i; });

      // ② 逐块显式识别：每条都带 recog 置信度（ok / check / fail），供「识别结果清单」核对。
      //    v3.2 起不再用「长度 ≤14 且无标点」猜小标题，改按语义词表 + 文献特征判定。
      doc.blocks.forEach((b, i) => {
        if (b.type === 'image') {
          if (b.recog == null) b.recog = 'ok';
          if (b.pageBreakBefore == null) b.pageBreakBefore = false;
          return;
        }
        const txt = texts[i];
        if (!txt) {
          b.recog = 'fail';                     // 空段 / 纯图片占位，需人工确认
          if (b.pageBreakBefore == null) b.pageBreakBefore = false;
          return;
        }
        // 已合并的导语不再重新判定，避免被拆回小标题
        if (b._mergedLead) {
          b.type = 'lead'; b.align = 'justify'; b.recog = 'ok';
          if (b.pageBreakBefore == null) b.pageBreakBefore = false;
          return;
        }
        let type, conf;
        if (i === firstText) {
          type = 'art-title'; conf = 'ok';
        } else if (LEAD_WORDS.some(w => txt.startsWith(w)) && txt.length > 25) {
          type = 'lead'; conf = 'ok';                                   // 通栏导语
        } else if (/^[【\[]/.test(txt) && /[】\]]/.test(txt) && txt.length >= 15) {
          type = 'cite-box'; conf = 'ok';                               // 文献来源
        } else if (isCaption(txt)) {
          type = 'caption'; conf = 'ok';                                // 图注 / 表题 / 标注
        } else if (isSectionHead(txt)) {
          type = 'label-head'; conf = 'ok';                             // 语义小标题
        } else if (isReference(txt)) {
          type = 'references'; conf = 'ok';                             // 参考文献条目
        } else if (/^\d+\s*[.、．]/.test(txt) && txt.length > 8 && txt.length < 90) {
          type = 'highlight'; conf = 'check';                           // 编号重点句：低置信度需确认
        } else if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') {
          type = b.type; conf = 'ok';
        } else {
          type = 'body';
          conf = (txt.length < 6 && !/[。！？!?]$/.test(txt)) ? 'check' : 'ok';
        }
        b.type = type;
        b.recog = conf;
        if (type === 'lead') b.html = wrapLeadKeyword(b.html);
        b.align = ALIGN_OF[type] || 'left';
        if (b.pageBreakBefore == null) b.pageBreakBefore = false;
      });

      // ③-a v3.4 P4：先按「参考文献 / References」小标题做结构判定，
      // 把其后连续文本块统一归为 references，避免无编号 / 作者名开头的文献漏判留在双栏。
      markReferenceZone(doc);
      // ③ 参考文献块按「<br> 后紧跟编号」拆条（连续编号 + 悬挂缩进的前提）
      explodeReferences(doc);

      // ③-b v3.3：编者按多段合并（第一段之后的连续正文段也归入通栏导语）
      extendLead(doc);

      // ④ 首页通栏显式槽位：标题 → 编者按（可多段）→ 文献截图 → 来源，之后才双栏。
      //    显式标记 + 重排，不再靠「第一张图」猜，文献截图不会再掉进双栏。
      layoutFrontMatter(doc);
    });
    return docs;
  }

  return { handleFiles, parseDocxFile, extractDocsFromZip, parseDocument,
           resolveMediaPath, imgMime, walkZip, applyTemplate, guessColumnName,
           extractQrcode, imageSize, isCaption, isSectionHead, isReference,
           markReferenceZone, plainText, SECTION_WORDS, classifyDoc, L1_LIST, CONF_L2, L3_LIST };
})();
