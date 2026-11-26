/**
 * marked 适配器。库的令牌与 Parser API 在这里转换成站点的渲染接口。
 * render(source, { heading, table }) 同步返回 HTML。
 * heading 接收 { depth, text, html }。
 * table 接收 { header, rows, align, mode, label }，单元格为 { text, html }。
 * mode 来自 table 注释，label 为最近的标题文字，均按源文档顺序确定。
 */
export function createMarkedProvider(marked) {
  return {
    render(source, { heading, table }) {
      // 每次解析独立创建配置，避免 marked.use() 的全局配置串到其他调用者。
      const renderer = new marked.Renderer();
      const options = { ...marked.getDefaults(), renderer };
      const tokens = marked.Lexer.lex(source, options);
      const tables = new WeakMap();
      let pendingMode = null;
      let lastHeading = '';
      const walk = (items) => {
        for (const token of items) {
          if (token.type === 'heading') {
            lastHeading = token.text.replace(/\s*\{[^}\s]+\}\s*$/, '').replace(/\s+/g, ' ').trim();
          }
          if (token.type === 'html') {
            const hint = /<!--\s*table:(compact|cards|matrix)\s*-->/.exec(token.text || '');
            if (hint) pendingMode = 't-' + hint[1];
          }
          if (token.type === 'table') {
            tables.set(token, { mode: pendingMode, label: lastHeading });
            pendingMode = null;
          }
          if (token.tokens) walk(token.tokens);
          if (token.items) walk(token.items);
        }
      };
      walk(tokens);
      renderer.heading = function (token) {
        return heading({ depth: token.depth, text: token.text, html: this.parser.parseInline(token.tokens) });
      };
      renderer.table = function (token) {
        const cell = (value) => ({ text: value.text, html: this.parser.parseInline(value.tokens) });
        return table({
          header: token.header.map(cell),
          rows: token.rows.map((row) => row.map(cell)),
          align: token.align,
          ...tables.get(token),
        });
      };
      return marked.Parser.parse(tokens, options);
    },
  };
}
