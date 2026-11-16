/* 质检与识别确认（v3.2 · 文档 04 / 08 章）
 *
 *  - 规则版质检：溢出 / 空页 / 标题孤悬 / 图注脱离 / 页面留白 / 字体字符 /
 *    医学符号 / 参考文献编号，分「阻断 / 警告 / 提示」三级，导出前常驻状态条徽标。
 *  - 识别结果清单：逐块列出识别类型与置信度（成功 / 需确认 / 失败），
 *    可直接改类型、上下调顺序，避免错误识别直接进入整刊。
 *  纯规则检查，不联网、不调大模型；后续可在此挂 LLM 语义复核。
 */
const QA = (() => {
  function $(id) { return document.getElementById(id); }
  let lastIssues = [];
  let tab = 'report';
  let lastRefreshAt = 0;   // v3.3 面板刷新反馈
  let resolvedDelta = 0;   // 本次调整解决的问题数
  let onlyTodo = false;    // v3.4：「只看未处理」开关
  // v3.4：勾选「已完成」——识别结果按块 id 存 b.qaDone；报告问题按「分类+描述」指纹存 state.qaDoneIssues
  function issueKey(i) { return i.level + '|' + i.cat + '|' + i.msg; }
  function stateDoneIssues() {
    const st = window.App && App.state;
    if (st && !Array.isArray(st.qaDoneIssues)) st.qaDoneIssues = [];
    return st ? st.qaDoneIssues : [];
  }
  function isDone(k) { return stateDoneIssues().indexOf(k) >= 0; }
  function setDone(k, v) {
    const arr = stateDoneIssues();
    const i = arr.indexOf(k);
    if (v && i < 0) arr.push(k);
    if (!v && i >= 0) arr.splice(i, 1);
    if (window.App && App.persistQa) App.persistQa();
  }

  function strip(html) {
    const d = document.createElement('div');
    d.innerHTML = html || '';
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function esc(s) { return U.escapeHtml(String(s == null ? '' : s)); }

  function recogCounts() {
    const st = window.App && App.state;
    const out = { ok: 0, check: 0, fail: 0 };
    if (!st) return out;
    st.docs.forEach(d => d.blocks.forEach(b => {
      const k = b.recog || (b.type === 'image' ? 'ok' : 'check');
      if (out[k] != null) out[k]++;
    }));
    return out;
  }

  /** 运行规则检查，返回 [{level:'block'|'warn'|'tip', cat, msg, page}] */
  function run() {
    const App = window.App;
    const issues = [];
    // v3.3：附带可定位的页码 / 块 id，报告条目点击后能跳到正文
    const push = (level, cat, msg, page, blockId) => {
      const m = /^P(\d+)$/.exec(page || '');
      issues.push({ level, cat, msg, page: page || '',
                    pageNo: m ? parseInt(m[1], 10) : null, blockId: blockId || '' });
    };
    if (!App) return issues;
    const st = App.state, layout = App.layout;

    // ---- 分页 / 分栏 / 溢出 ----
    if (layout && layout.pages) {
      layout.pages.forEach(pg => {
        if (pg.overflow) {
          push('block', '文本溢出',
            `第 ${pg.no} 页有内容超出单栏/单页高度。已不裁切、整块可见，建议缩短该段或手动插入分页。`, `P${pg.no}`);
        }
        if (pg.empty) push('block', '空白页', `第 ${pg.no} 页没有内容，建议删页或调整分页。`, `P${pg.no}`);
        if (pg.unbalanced) {
          push('tip', '页面留白', `第 ${pg.no} 页两栏高度差偏大，可增删文字或微调让版面更整齐。`, `P${pg.no}`);
        }
        // v3.3：留白率检查（问题整理 image3「每页要排满，不要出现突兀的大量留白」）
        if (!pg.overflow && !pg.empty && pg.colH > 0 && Array.isArray(pg.used) && pg.used.length) {
          const filled = Math.max.apply(null, pg.used);
          if (filled / pg.colH < 0.62) {
            push('warn', '页面留白',
              `第 ${pg.no} 页正文仅用约 ${Math.round(filled / pg.colH * 100)}% 栏高，建议把后续内容上提或调整块顺序。`, `P${pg.no}`);
          }
        }
        (pg.colBlocks || []).forEach((blocks, ci) => {
          if (!blocks.length) return;
          const last = blocks[blocks.length - 1];
          if (['label-head', 'h1', 'h2', 'h3', 'art-title'].includes(last.type)) {
            push('warn', '标题孤悬',
              `第 ${pg.no} 页第 ${ci + 1} 栏末尾是标题「${last.text || '（空）'}」，建议与后文保持同栏。`, `P${pg.no}`, last.id);
          }
          blocks.forEach((b, bi) => {
            if (b.type === 'caption') {
              const prev = blocks[bi - 1];
              if (!prev || prev.type !== 'image') {
                push('warn', '图注脱离',
                  `第 ${pg.no} 页图注「${b.text || '（空）'}」未紧跟图片，建议并入图片块的图注。`, `P${pg.no}`, b.id);
              }
            }
          });
        });
      });
    }

    // ---- 字体 / 字符 / 医学符号 ----
    const joined = [];
    st.docs.forEach(d => d.blocks.forEach(b => { if (b.html) joined.push(strip(b.html)); }));
    const text = joined.join(' ');
    if (/\uFFFD|\?\?\?/.test(text)) {
      push('block', '字体与字符', '发现替换字符（□/?）等疑似乱码，请核对导入源文档与字体。', '');
    }
    const MED = ['IFN-α', 'PegIFNα', 'HBsAg', 'HBV DNA', 'P＜0.05', 'P<0.05', '95% CI', 'α', 'β', 'γ', 'I²'];
    const hit = MED.filter(k => text.indexOf(k) >= 0);
    if (hit.length) {
      push('tip', '医学符号',
        `含 ${hit.join('、')} 等符号/上下标/希腊字母；导出后请抽样核对渲染，不要只依赖文本层。`, '');
    }

    // ---- 参考文献编号 / 位置 ----
    st.docs.forEach(d => {
      const refs = [];
      d.blocks.forEach((b, i) => { if (b.type === 'references') refs.push({ b, i }); });
      if (!refs.length) return;
      const nums = refs.map(r => {
        const m = strip(r.b.html).match(/^\[?(\d+)\]?/);
        return m ? parseInt(m[1], 10) : null;
      });
      const valid = nums.filter(n => n != null);
      if (valid.length > 1) {
        for (let i = 1; i < valid.length; i++) {
          if (valid[i] !== valid[i - 1] + 1) {
            push('warn', '参考文献', `「${d.name}」文献编号不连续：${valid[i - 1]} → ${valid[i]}。`, '');
            break;
          }
        }
        if (new Set(valid).size !== valid.length) {
          push('warn', '参考文献', `「${d.name}」存在重复文献编号。`, '');
        }
      }
      const lastRefIdx = refs[refs.length - 1].i;
      if (d.blocks.slice(lastRefIdx + 1).some(b => b.type !== 'references')) {
        push('warn', '参考文献', `「${d.name}」参考文献之后仍有其它内容，规则要求统一置于文章最后一页最底部。`, '');
      }
    });
    // v3.4 P4：疑似文献仍留在双栏区（未被识别成 references）时给出提示，避免静默漏判。
    // 判据只认「强文献特征」（作者著录 / 年份 / doi / 期刊名 / [J][M]），
    // 不用「指南 / 共识 / 杂志」等中文常见词——否则「1. 新版指南进一步放宽…」这类
    // 绿色编号重点句会被误报成文献，反而误导用户（用户明确不要自造定性判断）。
    st.docs.forEach(d => {
      let suspect = 0;
      d.blocks.forEach(b => {
        if (b.type !== 'body' && b.type !== 'highlight') return;
        const t = strip(b.html);
        if (!/^[\[［(（]?\d{1,3}[\]］)）]?\s*[.、．]/.test(t)) return;
        if (/et\s*al|doi\s*[:：]|https?:\/\/|PMID|\b(19|20)\d{2}\b|[\[［][JM][\]］]|\b(?:Hepatology|Journal|Lancet|Gastroenterology|Medicine|Gut|JAMA|NEJM)\b/i.test(t)) suspect++;
      });
      if (suspect) {
        push('warn', '参考文献', `「${d.name}」有 ${suspect} 段疑似参考文献仍在正文中（未归入页底文献带），建议到「识别结果」把它们改为「参考文献」。`, '');
      }
    });

    // ---- 识别置信度 ----
    const rc = recogCounts();
    if (rc.check + rc.fail > 0) {
      push('tip', '结构识别',
        `${rc.check + rc.fail} 个模块识别置信度偏低（需确认 ${rc.check} / 失败 ${rc.fail}），请到「识别结果」页签核对。`, '');
    }
    return issues;
  }

  function count(level) {
    return lastIssues.filter(i => i.level === level).length;
  }
  function blockingCount() { return count('block'); }
  function summaryText() {
    if (!lastIssues.length) return '';
    return `${count('block')} 阻断 / ${count('warn')} 警告 / ${count('tip')} 提示`;
  }

  function updateBadge() {
    const el = $('qaBadge');
    if (!el) return;
    const b = count('block'), w = count('warn'), t = count('tip');
    el.className = 'qa-badge' + (b ? ' has-block' : (w ? ' has-warn' : ''));
    el.textContent = b ? `质检：${b} 阻断 / ${w} 警告`
      : w ? `质检：${w} 警告 / ${t} 提示`
      : `质检通过${t ? '（' + t + ' 项提示）' : ''}`;
  }

  // v3.3：统一刷新入口 —— 重算规则、更新徽标、刷新已打开的面板，并给出「解决了几项」反馈
  function refresh() {
    const cnt = arr => arr.reduce((n, i) => n + (i.level === 'block' || i.level === 'warn' ? 1 : 0), 0);
    const before = cnt(lastIssues);
    lastIssues = run();
    resolvedDelta = Math.max(0, before - cnt(lastIssues));
    lastRefreshAt = Date.now();
    updateBadge();
    const m = $('qaModal');
    if (m && !m.hidden) renderPanel();
  }

  // 每次重排后刷新（由 App.renderPreviewInner 末尾调用）
  function onLayout() { refresh(); }

  // ---------------- 面板渲染 ----------------
  function renderReport() {
    const b = count('block'), w = count('warn'), t = count('tip');
    const layout = window.App && App.layout;
    const pageN = layout && layout.pages ? (layout.tocPages || 0) + layout.pages.length : 0;
    const stamp = lastRefreshAt
      ? new Date(lastRefreshAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
    const doneArr = stateDoneIssues();
    const doneN = lastIssues.filter(i => isDone(issueKey(i))).length;
    let h = `<div class="qa-summary">共 <b>${pageN}</b> 页 · ` +
      `<span class="lv-block">阻断 ${b}</span> / <span class="lv-warn">警告 ${w}</span> / ` +
      `<span class="lv-tip">提示 ${t}</span><br>` +
      `按刊物规格自动检查：溢出、空页、标题孤悬、图注脱离、留白率、字体字符、参考文献位置与编号。` +
      `导出不强制拦截，但建议先处理阻断级问题。<br>` +
      `<span style="color:#2c6b3f">最近刷新 ${stamp}${resolvedDelta ? ' · 本次调整已解决 ' + resolvedDelta + ' 项问题' : ''}</span> · 点任意问题可定位到正文<br>` +
      `<b>已标记完成 ${doneN} / ${lastIssues.length}</b>（勾选左侧复选框即记「修改完成」，状态随存档保存）</div>`;
    if (!lastIssues.length) {
      h += '<div class="qa-empty">未发现问题。</div>';
      return h;
    }
    const LV = { block: '阻断', warn: '警告', tip: '提示' };
    let shown = 0;
    lastIssues.forEach((i, idx) => {
      const k = issueKey(i);
      const done = isDone(k);
      if (onlyTodo && done) return;
      shown++;
      const goto = i.blockId ? 'block:' + i.blockId : (i.pageNo ? 'page:' + i.pageNo : '');
      h += `<div class="qa-issue lv-${i.level}${done ? ' qa-done' : ''}"${goto ? ` data-qa-goto="${esc(goto)}"` : ''}>` +
        `<label class="qa-chk" title="勾选＝我已修改完成" data-qa-stop="1">` +
          `<input type="checkbox" data-qa-done-issue="${esc(k)}"${done ? ' checked' : ''} /> 完成</label>` +
        `<span class="qa-cat">${LV[i.level]} · ${esc(i.cat)}</span>` +
        `<span class="qa-msg">${esc(i.msg)}</span>` +
        (i.page ? `<span class="qa-pg">${esc(i.page)}</span>` : '') + '</div>';
    });
    if (!shown) h += '<div class="qa-empty">没有未处理的问题，全部已勾选完成。</div>';
    return h;
  }

  function renderRecog() {
    const App = window.App;
    if (!App) return '<div class="qa-empty">工具尚未就绪。</div>';
    const st = App.state;
    const rc = recogCounts();
    let total = 0, doneN = 0;
    st.docs.forEach(d => d.blocks.forEach(b => { total++; if (b.qaDone) doneN++; }));
    let h = `<div class="qa-summary">识别成功 <b>${rc.ok}</b> · 需确认 <b>${rc.check}</b> · ` +
      `失败 <b>${rc.fail}</b><br>可逐块改模块类型、上下调整顺序；改动即时重排并刷新下方质检结果。` +
      `点任意条目可直接定位到正文对应段落。` +
      `「需确认」多为编号重点句等低置信度判定，「失败」多为空段。<br>` +
      `<b>已标记完成 ${doneN} / ${total}</b>（勾选左侧复选框＝已核对，状态随存档保存）</div>`;
    if (!st.docs.length) return h + '<div class="qa-empty">暂无文档。</div>';
    const labels = App.TYPE_LABEL || {};
    const types = App.ALLOWED_TYPES || [];
    let shown = 0;
    st.docs.forEach(d => {
      h += `<div class="qa-doc">${esc(d.columnName ? '[' + d.columnName + '] ' : '')}${esc(d.name)}</div>`;
      d.blocks.forEach((b, i) => {
        if (onlyTodo && b.qaDone) return;
        shown++;
        const r = b.recog || 'check';
        const rst = { ok: '成功', check: '需确认', fail: '失败' }[r] || '需确认';
        const txt = b.type === 'image' ? '［图片］' : strip(b.html);
        let opts = '';
        types.forEach(t => {
          opts += `<option value="${t}"${t === b.type ? ' selected' : ''}>${esc(labels[t] || t)}</option>`;
        });
        h += `<div class="qa-recog${b.qaDone ? ' qa-done' : ''}" data-qa-goto="block:${esc(b.id)}" title="点击定位到正文">` +
          `<label class="qa-chk" title="勾选＝我已核对完成" data-qa-stop="1">` +
            `<input type="checkbox" data-qa-done-block="${esc(b.id)}"${b.qaDone ? ' checked' : ''} /> 完成</label>` +
          `<span class="rk">${i + 1}</span>` +
          `<span class="rtxt" title="${esc(txt)}">${esc(txt.slice(0, 60) || '（空）')}</span>` +
          `<select data-qa-type="${esc(b.id)}" title="模块类型">${opts}</select>` +
          `<span class="rst ${r}">${rst}</span>` +
          `<button class="rmv" data-qa-move="${esc(b.id)}" data-dir="-1" title="上移">↑</button>` +
          `<button class="rmv" data-qa-move="${esc(b.id)}" data-dir="1" title="下移">↓</button>` +
          `</div>`;
      });
    });
    if (!shown) h += '<div class="qa-empty">没有未处理的条目，全部已勾选完成。</div>';
    return h;
  }

  function renderPanel() {
    const body = $('qaBody');
    if (!body) return;
    body.innerHTML = tab === 'report' ? renderReport() : renderRecog();
    const info = $('qaInfo');
    if (info) info.textContent = tab === 'report'
      ? `分级摘要：${summaryText() || '无问题'}`
      : `逐块核对识别结果，可改类型与顺序`;
    document.querySelectorAll('.qa-tab').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-qa-tab') === tab);
    });
    if (tab === 'recog') {
      body.querySelectorAll('[data-qa-type]').forEach(sel => {
        sel.addEventListener('change', e => {
          App.applyBlockType(sel.getAttribute('data-qa-type'), e.target.value);
        });
      });
      body.querySelectorAll('[data-qa-move]').forEach(btn => {
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          App.moveBlock(btn.getAttribute('data-qa-move'), parseInt(btn.getAttribute('data-dir'), 10));
        });
      });
    }
    // v3.4：复选框 change → 写状态（不重排、不定位），只局部刷新面板
    body.querySelectorAll('[data-qa-done-issue]').forEach(chk => {
      chk.addEventListener('change', e => {
        setDone(chk.getAttribute('data-qa-done-issue'), e.target.checked);
        renderPanel();
      });
    });
    body.querySelectorAll('[data-qa-done-block]').forEach(chk => {
      chk.addEventListener('change', e => {
        const id = chk.getAttribute('data-qa-done-block');
        const st = window.App && App.state;
        const b = st && st.blockMap ? st.blockMap[id] : null;
        if (b) b.qaDone = e.target.checked;
        if (window.App && App.persistQa) App.persistQa();
        renderPanel();
      });
    });
    // 复选框 / 其 label 的点击不能冒泡到行上的「点击定位」
    body.querySelectorAll('[data-qa-stop]').forEach(el => {
      el.addEventListener('click', ev => ev.stopPropagation());
    });
    // v3.3：报告 / 识别结果条目点击 → 定位到正文（块或页）
    body.querySelectorAll('[data-qa-goto]').forEach(el => {
      el.addEventListener('click', ev => {
        ev.stopPropagation();
        const g = el.getAttribute('data-qa-goto');
        if (window.App && App.gotoQaTarget) App.gotoQaTarget(g);
      });
    });
  }

  function open() {
    const m = $('qaModal');
    if (!m) return;
    m.hidden = false;
    refresh();
    renderPanel();
  }
  function close() { const m = $('qaModal'); if (m) m.hidden = true; }

  function bindUI() {
    const m = $('qaModal');
    if (m) m.classList.add('qa-modal');
    const c = $('qaClose'); if (c) c.addEventListener('click', close);
    document.querySelectorAll('.qa-tab').forEach(btn => {
      btn.addEventListener('click', () => { tab = btn.getAttribute('data-qa-tab'); renderPanel(); });
    });
    // v3.4：「只看未处理」开关
    const ot = $('qaOnlyTodo');
    if (ot) ot.addEventListener('change', () => { onlyTodo = ot.checked; renderPanel(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && m && !m.hidden) close();
    });
    updateBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindUI);
  } else {
    bindUI();
  }

  return { run, open, close, onLayout, refresh, blockingCount, summaryText, renderPanel };
})();
window.QA = QA;
