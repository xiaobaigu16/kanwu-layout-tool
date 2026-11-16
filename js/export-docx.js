/* 导出 Word（.docx）：手写 OOXML 包
   - 每篇文章独立分节（分栏数随文章设置），通栏块用连续分节实现横跨整页
   - 每个分节都引用页眉/页脚，保证每一页都有页眉页脚与页码
   - 标题加书签；目录 = 超链接 + 点线引导符 + PAGEREF 域（真实页码，F9 可刷新）
   - 模板样式：文章标题 / 引用框（绿色底纹）/ 绿色标签（白字绿底小标签）
   - 文章首页右上角浮动二维码；文章首页左侧浮动竖排栏目标签 */
const ExportDocx = (() => {

  function htmlToRuns(html, initFmt) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    const runs = [];
    const walk = (node, fmt) => {
      if (node.nodeType === 3) {
        if (node.textContent) runs.push({ text: node.textContent, ...fmt });
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      const f = { ...fmt };
      if (tag === 'b' || tag === 'strong') f.bold = true;
      else if (tag === 'i' || tag === 'em') f.italic = true;
      else if (tag === 'u') f.underline = true;
      else if (tag === 'sub') f.sub = true;
      else if (tag === 'sup') f.sup = true;
      else if (tag === 'span') {
        // 工具栏把「真实 pt」记在 data-pt 上（CSS 里是 calc(…pt*--fs) 的缩放值），
        // 导出 Word 要用真实 pt，不能用缩放后的预览值
        const dp = node.getAttribute('data-pt');
        const st = node.getAttribute('style') || '';
        if (dp) f.sizePt = parseFloat(dp);
        else {
          const fs = st.match(/font-size:\s*([\d.]+)pt/);
          if (fs) f.sizePt = parseFloat(fs[1]);
        }
        const col = st.match(/color:\s*(#[0-9a-fA-F]{3,6})/);
        if (col) f.color = col[1].replace('#', '');
        if (/font-weight:\s*(bold|[6-9]00)/.test(st)) f.bold = true;
        const ff = st.match(/font-family:\s*([^;]+)/);
        if (ff) f.fontFamily = ff[1].trim().replace(/^["']|["']$/g, '');
      }
      for (const c of node.childNodes) walk(c, f);
    };
    walk(doc.body, Object.assign({ bold: false, italic: false, underline: false,
      sub: false, sup: false, sizePt: null, color: null, fontFamily: null }, initFmt || {}));
    if (runs.length === 0) runs.push({ text: '' });
    return runs;
  }

  function runXml(r) {
    let inner = '';
    if (r.bold) inner += '<w:b/>';
    if (r.italic) inner += '<w:i/>';
    if (r.underline) inner += '<w:u/>';
    if (r.sub) inner += '<w:vertAlign w:val="subscript"/>';
    if (r.sup) inner += '<w:vertAlign w:val="superscript"/>';
    if (r.fontFamily) {
      const ff = U.escapeXml(r.fontFamily);
      inner += `<w:rFonts w:ascii="${ff}" w:eastAsia="${ff}" w:hAnsi="${ff}"/>`;
    }
    if (r.sizePt) inner += `<w:sz w:val="${Math.round(r.sizePt * 2)}"/><w:szCs w:val="${Math.round(r.sizePt * 2)}"/>`;
    if (r.color) inner += `<w:color w:val="${r.color.replace('#', '')}"/>`;
    const rpr = inner ? `<w:rPr>${inner}</w:rPr>` : '';
    return `<w:r>${rpr}<w:t xml:space="preserve">${U.escapeXml(r.text)}</w:t></w:r>`;
  }

  function stripHtml(html) {
    const d = new DOMParser().parseFromString(html || '', 'text/html');
    return (d.body.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // 成品目录页码三位补零（001 / 003 / 007），手动填的非数字原样保留
  function padPage(v) {
    const s = String(v == null ? '' : v).trim();
    return /^\d+$/.test(s) ? s.padStart(3, '0') : s;
  }
  // v3.4 P2：目录条目去掉开头的【期刊导读】等栏目名前缀（只影响目录显示，正文标题原文不改）
  function cleanTocText(t) {
    const s = String(t == null ? '' : t);
    return s.replace(/^\s*[【\[［]\s*[^】\]］]{1,12}\s*[】\]］]\s*/, '').trim() || s;
  }

  function blockParagraph(b, bm) {
    // 绿色小标题：白皮书是纯绿色粗体文字，不是绿底白字标签
    if (b.type === 'label-head') {
      const txt = stripHtml(b.html) || '小标题';
      const runs = `<w:r><w:rPr><w:color w:val="008000"/><w:b/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr><w:t xml:space="preserve">${U.escapeXml(txt)}</w:t></w:r>`;
      const inner = bm
        ? `<w:bookmarkStart w:id="${bm.id}" w:name="${bm.name}"/>${runs}<w:bookmarkEnd w:id="${bm.id}"/>`
        : runs;
      return `<w:p><w:pPr><w:pStyle w:val="LabelHead"/><w:spacing w:before="160" w:after="80"/></w:pPr>${inner}</w:p>`;
    }
    const styleMap = { h1: 'Heading1', h2: 'Heading2', h3: 'Heading3', caption: 'Caption',
                       'art-title': 'ArtTitle', 'cite-box': 'Source', lead: 'Lead',
                       highlight: 'Highlight', references: 'References' };
    const ppr = [];
    if (styleMap[b.type]) ppr.push(`<w:pStyle w:val="${styleMap[b.type]}"/>`);
    const align = b.align || (b.type === 'caption' ? 'center' : 'left');
    const jcMap = { left: 'left', center: 'center', right: 'right', justify: 'both' };
    ppr.push(`<w:jc w:val="${jcMap[align] || 'left'}"/>`);
    const lh = b.lineHeight ? parseFloat(b.lineHeight) : (b.type.startsWith('h') ? 1.25 : null);
    const useLH = lh || stateLineH;
    ppr.push(`<w:spacing w:line="${Math.round(useLH * 240)}" w:lineRule="auto"/>`);
    const pprXml = `<w:pPr>${ppr.join('')}</w:pPr>`;
    // 工具栏在块级设置的字号 / 字体 / 颜色作为整段默认格式；
    // 段内 span 的 data-pt / 内联样式优先于它
    const initFmt = {};
    if (b.fontPt) initFmt.sizePt = b.fontPt;
    if (b.fontFamily) initFmt.fontFamily = b.fontFamily;
    if (b.color) initFmt.color = b.color.replace('#', '');
    let runs = htmlToRuns(b.html, initFmt).map(runXml).join('');
    // 文章标题前的绿色方块图标（白皮书样式）
    if (b.type === 'art-title') {
      // 成品标题图标：实心方块 + 空心方块（Word 用字符近似）
      runs = `<w:r><w:rPr><w:color w:val="008000"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t xml:space="preserve">■□ </w:t></w:r>` + runs;
    }
    if (bm) {
      return `<w:p>${pprXml}<w:bookmarkStart w:id="${bm.id}" w:name="${bm.name}"/>${runs}<w:bookmarkEnd w:id="${bm.id}"/></w:p>`;
    }
    return `<w:p>${pprXml}${runs}</w:p>`;
  }

  let stateLineH = 1.64;
  let docPrId = 100;
  let picId = 100;

  async function preload(sources) {
    const map = {}; // src -> {base64, type, ext, w, h, rid}
    let rid = 4;    // rId1=页眉 rId2=页脚 rId3=样式，图片/二维码从 rId4 起（连续唯一）
    const tasks = sources.map(src => new Promise(res => {
      if (!src || map[src]) return res();
      const img = new Image();
      img.onload = () => {
        const m = src.match(/^data:(image\/\w+);base64,/);
        const ext = m ? m[1].split('/')[1] : 'png';
        const type = m ? m[1] : 'image/png';
        map[src] = { base64: src.split(',')[1], type, ext, w: img.naturalWidth, h: img.naturalHeight, rid: 'rId' + (rid++) };
        res();
      };
      img.onerror = () => { map[src] = null; res(); };
      img.src = src;
    }));
    await Promise.all(tasks);
    return map;
  }

  // 正文图片（内联）
  function imageParagraph(block, assetMap, contentWidthTwips) {
    const im = assetMap[block.src];
    if (!im) return '';
    const maxWmm = contentWidthTwips / (1440 / 25.4);
    let wMm = Math.min(maxWmm, 110);   // 通栏文献截图约 110mm；栏内图自动受栏宽限制
    let hMm = im.w ? wMm * (im.h / im.w) : wMm * 0.6;
    const cx = U.mmToEmu(wMm), cy = U.mmToEmu(hMm);
    const did = ++docPrId, pid = ++picId;
    const pic = `
<w:p><w:pPr><w:jc w:val="center"/></w:pPr>
  <w:r>
    <w:drawing>
      <wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="${cx}" cy="${cy}"/>
        <wp:effectExtent l="0" t="0" r="0" b="0"/>
        <wp:docPr id="${did}" name="pic${did}"/>
        <wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>
        <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:nvPicPr><pic:cNvPr id="${pid}" name="pic${pid}"/><pic:cNvPicPr/></pic:nvPicPr>
              <pic:blipFill><a:blip r:embed="${im.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
              <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
              <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing>
  </w:r>
</w:p>`;
    let cap = '';
    if (block.caption) {
      cap = `<w:p><w:pPr><w:jc w:val="center"/><w:pStyle w:val="Caption"/></w:pPr>` +
            `<w:r><w:t xml:space="preserve">${U.escapeXml(block.caption)}</w:t></w:r></w:p>`;
    }
    return pic + cap;
  }

  // 浮动二维码（文章首页右上角）
  function qrParagraph(doc, assetMap) {
    const q = assetMap[doc.qr];
    if (!q) return '';
    const sizeMm = 20;
    const cx = U.mmToEmu(sizeMm), cy = U.mmToEmu(sizeMm);
    const posV = U.mmToEmu(15); // v3.2：与上边距齐平，二维码完全落在标题水平带内，不压编者按
    const did = ++docPrId, pid = ++picId;
    return `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:drawing>` +
      `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
      `<wp:simplePos x="0" y="0"/>` +
      `<wp:positionH relativeFrom="page"><wp:align>right</wp:align></wp:positionH>` +
      `<wp:positionV relativeFrom="page"><wp:posOffset>${posV}</wp:posOffset></wp:positionV>` +
      `<wp:extent cx="${cx}" cy="${cy}"/>` +
      `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
      `<wp:wrapNone/>` +
      `<wp:docPr id="${did}" name="qr${did}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<pic:nvPicPr><pic:cNvPr id="${pid}" name="qr${pid}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${q.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`;
  }

  // v3.3：竖排标签按一级栏目配不同底色（与预览一致）
  const TAB_COLORS = { '期刊导读':'#5FAA31', '数据阅独':'#36A9CC', '会议撷萃':'#4174F2',
                       '新药进展':'#E08A2E', '名家访谈':'#8B5CC7', '项目进展':'#C0506B' };
  function TAB_COLOR(doc) {
    if (typeof window !== 'undefined' && window.App && App.tabColorFor) return App.tabColorFor(doc);
    return TAB_COLORS[doc && doc.cat1] || '#58A830';
  }

  // 浮动竖排栏目标签（文章首页左侧，按栏目底色 + 白字）
  function labelParagraph(doc) {
    if (!doc.columnName) return '';
    const name = U.escapeXml(doc.columnName);
    // v3.4 P3：栏目框完全贴页边（x 0mm 起），与预览一致；8.9×38.1mm、从页顶 y=0 起
    const leftPt = (0 * 2.834645669).toFixed(1);
    const widthPt = (8.9 * 2.834645669).toFixed(1);
    const heightPt = (38.1 * 2.834645669).toFixed(1);
    return `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:pict>` +
      `<v:shape type="#_x0000_t202" style="position:absolute;left:${leftPt}pt;top:0pt;width:${widthPt}pt;height:${heightPt}pt;mso-position-horizontal-relative:page;mso-position-vertical-relative:page" fillcolor="${TAB_COLOR(doc)}" strokecolor="${TAB_COLOR(doc)}" xmlns:v="urn:schemas-microsoft-com:vml">` +
      `<v:textbox inset="2pt,3pt,2pt,3pt" style="mso-fit-shape-to-text:t">` +
      `<w:txbxContent><w:p><w:pPr><w:textDirection w:val="tbRl"/><w:jc w:val="center"/><w:spacing w:line="240" w:lineRule="auto"/></w:pPr>` +
      `<w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t xml:space="preserve">${name}</w:t></w:r>` +
      `</w:p></w:txbxContent></v:textbox></v:shape>` +
      `</w:pict></w:r></w:p>`;
  }

  function sectPrXml(p, cols, startType, leftMM, pgStart, noFooter) {
    // 目录节不引用页脚（成品目录页不显示页码）；正文节引用页脚显示 PAGE 域
    const refs = `<w:headerReference w:type="default" r:id="rId1"/>` +
      (noFooter ? '' : `<w:footerReference w:type="default" r:id="rId2"/>`);
    const colsXml = cols === 2 ? `<w:cols w:num="2" w:space="692"/>` : `<w:cols w:num="1"/>`;
    const leftTw = U.mmToTwips(leftMM == null ? p.ml : leftMM);
    // v3.3：正文第一节重置页码为 1，目录页不占号，PAGEREF 域随之返回 001 起算
    const pgNum = pgStart ? `<w:pgNumType w:start="${pgStart}"/>` : '';
    return `<w:sectPr>${refs}<w:type w:val="${startType}"/>` +
      `<w:pgSz w:w="${U.mmToTwips(p.w)}" w:h="${U.mmToTwips(p.h)}"/>` +
      `<w:pgMar w:top="${U.mmToTwips(p.mt)}" w:bottom="${U.mmToTwips(p.mb)}" w:left="${leftTw}" w:right="${U.mmToTwips(p.mr)}" w:header="720" w:footer="720" w:gutter="0"/>` +
      pgNum + colsXml + `</w:sectPr>`;
  }

  let statePage = null;

  async function run(state, lastPageLabels) {
    stateLineH = state.page.lineH || 1.77;   // v3.3：10.6pt × 1.77 ≈ 18.8pt = 6.63mm（成品实测）
    statePage = state.page;
    docPrId = 100; picId = 100;
    const p = state.page;
    const bodyBlocks = [];
    state.docs.forEach(d => d.blocks.forEach(b => bodyBlocks.push(b)));

    // 预加载所有图片与二维码（共用一套 rId，保证唯一）
    const sources = [];
    bodyBlocks.forEach(b => { if (b.type === 'image' && b.src) sources.push(b.src); });
    state.docs.forEach(d => { if (d.qr) sources.push(d.qr); });
    const assetMap = await preload(sources);
    const contentWidthTwips = U.mmToTwips(p.w - p.ml - p.mr);

    const FULL_TYPES = ['art-title', 'lead', 'cite-box'];
    const blockFull = b => (b.full === true || b.full === false) ? b.full : FULL_TYPES.includes(b.type);

    // 书签分配（标题块）
    const bookmarkFor = {}; // blockId -> {id, name}
    let bmId = 1;
    bodyBlocks.forEach(b => {
      if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3' || b.type === 'art-title') {
        bookmarkFor[b.id] = { id: bmId, name: '_bm_toc' + bmId };
        bmId++;
      }
    });

    let paras = '';

    // ---------- 目录（单栏节；超链接 + 点线 + PAGEREF） ----------
    if (state.tocEnabled && state.tocEntries.length) {
      // 成品目录标题：深绿 #187838 矩形块「目录」+ 深绿 CONTENTS
      paras += `<w:p><w:pPr><w:spacing w:after="240"/></w:pPr>` +
        `<w:r><w:rPr><w:shd w:val="clear" w:color="auto" w:fill="187838"/><w:color w:val="FFFFFF"/><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr><w:t xml:space="preserve">目录</w:t></w:r>` +
        `<w:r><w:rPr><w:color w:val="187838"/><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t xml:space="preserve">　CONTENTS</w:t></w:r></w:p>`;
      const tabPos = contentWidthTwips - 200;
      let lastCol = null, lastC2 = null, lastC3 = null, colNo = 0;
      const CN = ['一','二','三','四','五','六','七','八','九','十'];
      state.tocEntries.forEach(e => {
        if (e.column && e.column !== lastCol) {
          colNo++;
          // v3.4 P2：分组标题改常规字重（去掉 <w:b/>），保留绿色
          paras += `<w:p><w:pPr><w:spacing w:before="200" w:after="60"/></w:pPr>` +
            `<w:r><w:rPr><w:color w:val="008000"/><w:sz w:val="26"/></w:rPr>` +
            `<w:t xml:space="preserve">${CN[colNo - 1] || colNo}、${U.escapeXml(e.column)}</w:t></w:r></w:p>`;
          lastCol = e.column; lastC2 = null; lastC3 = null;
        }
        // v3.3 二级 / 三级分类标题（往期目录：会议名 → 主题 → 条目）
        if (e.cat2 && e.cat2 !== lastC2) {
          paras += `<w:p><w:pPr><w:spacing w:before="120" w:after="40"/><w:ind w:left="240"/></w:pPr>` +
            `<w:r><w:rPr><w:color w:val="008000"/><w:sz w:val="22"/></w:rPr>` +
            `<w:t xml:space="preserve">${U.escapeXml(e.cat2)}</w:t></w:r></w:p>`;
          lastC2 = e.cat2; lastC3 = null;
        }
        if (e.cat3 && e.cat3 !== lastC3) {
          paras += `<w:p><w:pPr><w:spacing w:before="80" w:after="30"/><w:ind w:left="480"/></w:pPr>` +
            `<w:r><w:rPr><w:color w:val="008000"/><w:sz w:val="21"/></w:rPr>` +
            `<w:t xml:space="preserve">${U.escapeXml(e.cat3)}</w:t></w:r></w:p>`;
          lastC3 = e.cat3;
        }
        const bm = bookmarkFor[e.targetId];
        // v3.4 P2：一级条目由粗体改常规（保留绿色），与往期样例一致
        const rpr = e.level === 'h1'
          ? '<w:rPr><w:color w:val="008000"/></w:rPr>'
          : '<w:rPr><w:color w:val="333333"/></w:rPr>';
        const tocTxt = cleanTocText(e.text);
        let entryRuns = '';
        if (bm) {
          entryRuns += `<w:hyperlink w:anchor="${bm.name}" w:history="1">` +
            `<w:r>${rpr}<w:t xml:space="preserve">${U.escapeXml(tocTxt)}</w:t></w:r></w:hyperlink>`;
        } else {
          entryRuns += `<w:r>${rpr}<w:t xml:space="preserve">${U.escapeXml(tocTxt)}</w:t></w:r>`;
        }
        entryRuns += `<w:r><w:tab/></w:r>`;
        if (bm) {
          entryRuns += `<w:r><w:fldSimple w:instr=" PAGEREF ${bm.name} \\h ">` +
            `<w:r><w:t>${U.escapeXml(padPage(e.page))}</w:t></w:r></w:fldSimple></w:r>`;
        } else {
          entryRuns += `<w:r><w:t xml:space="preserve">${U.escapeXml(padPage(e.page))}</w:t></w:r>`;
        }
        const indent = e.level === 'h2' ? 240 : e.level === 'h3' ? 480 : 0;
        paras += `<w:p><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${tabPos}"/></w:tabs>` +
          (indent ? `<w:ind w:left="${indent}"/>` : '') +
          `<w:spacing w:line="394" w:lineRule="auto"/></w:pPr>${entryRuns}</w:p>`;
      });
      paras += `<w:p><w:pPr>${sectPrXml(p, 1, 'nextPage', null, null, true)}</w:pPr></w:p>`;
    }

    // ---------- 正文：每篇文章一节起新页；文章内部按 通栏/分栏 再细分连续节 ----------
    state.docs.forEach((d, di) => {
      const groups = []; // {full:boolean, blocks:[]}
      d.blocks.forEach(b => {
        const g = groups[groups.length - 1];
        const f = blockFull(b);
        if (g && g.full === f) g.blocks.push(b);
        else groups.push({ full: f, blocks: [b] });
      });
      groups.forEach((g, gi) => {
        // 文章首页：浮动栏目标签 + 二维码
        if (gi === 0) {
          paras += labelParagraph(d);
          paras += qrParagraph(d, assetMap);
        }
        g.blocks.forEach(b => {
          if (b.type === 'image') paras += imageParagraph(b, assetMap, contentWidthTwips);
          else paras += blockParagraph(b, bookmarkFor[b.id] || null);
        });
        const startType = gi === 0 ? 'nextPage' : 'continuous';
        const isVeryLast = (di === state.docs.length - 1 && gi === groups.length - 1);
        const cols = g.full ? 1 : (d.cols || p.cols || 1); // 通栏组必须单栏
        const leftMM = g.full ? Math.max(8, p.ml - 10.9) : p.ml; // 通栏区向左外扩到 12mm
        const pgStart = (di === 0 && gi === 0) ? 1 : null;   // v3.3 正文首页从 1 起算
        if (isVeryLast) {
          paras += '\u0000SECT\u0000' + sectPrXml(p, cols, startType, leftMM, pgStart);
        } else {
          paras += `<w:p><w:pPr>${sectPrXml(p, cols, startType, leftMM, pgStart)}</w:pPr></w:p>`;
        }
      });
    });

    // 替换 body 级 sectPr 占位
    let bodyLevelSect = '';
    const m = paras.match(/\u0000SECT\u0000([\s\S]*?)$/);
    if (m) {
      bodyLevelSect = m[1];
      paras = paras.slice(0, m.index);
    }
    if (!bodyLevelSect) bodyLevelSect = sectPrXml(p, 1, 'nextPage');

    const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>${U.escapeXml(p.hdr || '')}</w:t></w:r></w:p></w:hdr>`;
    let ftrRuns = '';
    if (p.ftr) ftrRuns += `<w:r><w:t xml:space="preserve">${U.escapeXml(p.ftr)}</w:t></w:r>`;
    if (p.showNum) ftrRuns += `<w:r><w:fldSimple w:instr="PAGE"/></w:r>`;
    const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${ftrRuns || '<w:r><w:fldSimple w:instr="PAGE"/></w:r>'}</w:p></w:ftr>`;

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingml"
 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
 xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${paras}${bodyLevelSect}</w:body></w:document>`;

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="思源宋体"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:jc w:val="both"/><w:ind w:firstLine="400"/><w:spacing w:line="394" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:eastAsia="思源宋体" w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="21"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:ind w:firstLine="0"/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:eastAsia="思源宋体" w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:sz w:val="26"/><w:color w:val="008000"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:ind w:firstLine="0"/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:eastAsia="思源宋体" w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:sz w:val="22"/><w:color w:val="008000"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:ind w:firstLine="0"/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:rFonts w:eastAsia="思源宋体" w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:sz w:val="21"/><w:color w:val="008000"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0"/><w:spacing w:before="60" w:after="120"/></w:pPr><w:rPr><w:rFonts w:eastAsia="思源宋体" w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:sz w:val="18"/><w:color w:val="222222"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ArtTitle"><w:name w:val="Art Title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:jc w:val="left"/><w:ind w:firstLine="0"/><w:spacing w:before="120" w:after="360"/></w:pPr><w:rPr><w:rFonts w:eastAsia="思源宋体" w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:sz w:val="30"/><w:color w:val="008000"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Source"><w:name w:val="Source"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="left"/><w:ind w:firstLine="0" w:left="120"/><w:spacing w:before="60" w:after="140"/></w:pPr><w:rPr><w:rFonts w:eastAsia="思源宋体" w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="17"/><w:color w:val="7A8492"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Lead"><w:name w:val="Lead"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="both"/><w:ind w:firstLine="0"/><w:spacing w:before="120" w:after="200"/></w:pPr><w:rPr><w:rFonts w:eastAsia="思源宋体" w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="21"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Highlight"><w:name w:val="Highlight"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="left"/><w:ind w:firstLine="0"/><w:spacing w:before="100" w:after="100"/></w:pPr><w:rPr><w:rFonts w:eastAsia="思源宋体" w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:sz w:val="21"/><w:color w:val="008000"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="LabelHead"><w:name w:val="Label Head"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:jc w:val="left"/><w:ind w:firstLine="0"/><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:rFonts w:eastAsia="思源宋体" w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:sz w:val="21"/><w:color w:val="008000"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="References"><w:name w:val="References"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="left"/><w:ind w:left="340" w:hanging="340"/><w:spacing w:before="0" w:after="60" w:line="300" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:eastAsia="思源宋体" w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="15"/><w:szCs w:val="15"/><w:color w:val="333333"/></w:rPr></w:style>
</w:styles>`;

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Default Extension="jpg" ContentType="image/jpeg"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`;

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    let docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
    Object.values(assetMap).forEach((im, i) => {
      if (!im) return;
      docRels += `<Relationship Id="${im.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.${im.ext}"/>`;
    });
    docRels += '</Relationships>';

    const zip = new JSZip();
    zip.file('[Content_Types].xml', contentTypes);
    zip.file('_rels/.rels', rootRels);
    zip.file('word/document.xml', documentXml);
    zip.file('word/styles.xml', stylesXml);
    zip.file('word/header1.xml', headerXml);
    zip.file('word/footer1.xml', footerXml);
    zip.file('word/_rels/document.xml.rels', docRels);
    let mi = 0;
    Object.values(assetMap).forEach(im => {
      if (!im) return;
      mi++;
      zip.file(`word/media/image${mi}.${im.ext}`, im.base64, { base64: true });
    });

    const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    U.download(blob, '刊物内页_' + Date.now() + '.docx');
    U.toast('Word 已导出');
  }

  return { run };
})();
