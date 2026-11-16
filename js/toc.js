/* 目录：从文档标题块自动提取条目（按栏目分组，供预览/导出使用）
   - 文章标题(art-title)、一/二/三级标题均进入目录
   - 每条含 level（用于缩进/层级）、targetId（跳转/超链接）、column（栏目分组） */
const Toc = (() => {
  function blockText(b) {
    const tmp = document.createElement('div');
    tmp.innerHTML = b.html || '';
    return (tmp.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function levelOf(type) {
    if (type === 'art-title' || type === 'h1') return 'h1';
    if (type === 'h2') return 'h2';
    if (type === 'h3') return 'h3';
    return null;
  }

  function buildFromDocs(docs) {
    const entries = [];
    docs.forEach(doc => {
      doc.blocks.forEach(b => {
        const level = levelOf(b.type);
        if (!level) return;
        const text = blockText(b);
        if (!text) return;
        entries.push({
          id: U.uid('toc'),
          text,
          level,
          targetId: b.id,
          column: doc.cat1 || doc.columnName || '',
          cat2: doc.cat2 || '',
          cat3: doc.cat3 || '',
          page: '',
          custom: false,    // 是否用户手加
          manualPage: false // 是否手动锁定页码
        });
      });
    });
    return entries;
  }

  return { buildFromDocs };
})();
